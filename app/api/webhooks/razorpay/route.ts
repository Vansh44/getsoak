import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  billingWebhookEvents,
  planEvents,
  razorpayPlans,
  storeSubscriptions,
  stores,
} from "@/drizzle/schema";
import { STORE_TAG } from "@/lib/store/resolve";
import { verifyWebhookSignature } from "@/lib/payments/razorpay";
import { PLAN_META, normalizePlan } from "@/lib/plans";
import { recordEvent } from "@/lib/notifications/record";
import {
  resolveBillingEmail,
  sendBillingEmail,
  manageUrl,
  paymentReceiptTemplate,
  paymentFailedTemplate,
  subscriptionCancelledTemplate,
} from "@/lib/email/billing-emails";

// Razorpay Subscription webhooks — the source of truth for recurring billing.
// Renewals, failed charges (dunning), cancellations and plan changes all arrive
// here and drive stores.plan / plan_expires_at (the plan-expiry cron then
// downgrades a lapsed plan to free).
//
// Security: the RAW body is HMAC-verified against RAZORPAY_WEBHOOK_SECRET
// (X-Razorpay-Signature). Idempotent: every X-Razorpay-Event-Id is recorded
// once (billing_webhook_events), so redelivered events are no-ops. On a
// processing error we remove the marker and 500 so Razorpay retries.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Grace window after retries are exhausted before we downgrade (owner: 3 days).
const GRACE_DAYS = 3;

interface RzpSubEntity {
  id: string;
  status: string;
  plan_id: string | null;
  paid_count: number | null;
  current_start: number | null;
  current_end: number | null;
}

interface WebhookBody {
  event?: string;
  created_at?: number;
  payload?: { subscription?: { entity?: RzpSubEntity } };
}

async function handle(request: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("razorpay webhook: RAZORPAY_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const raw = await request.text();
  const sig = request.headers.get("x-razorpay-signature") ?? "";
  if (!verifyWebhookSignature(secret, raw, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let event: WebhookBody;
  try {
    event = JSON.parse(raw) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const sub = event.payload?.subscription?.entity;
  const eventId =
    request.headers.get("x-razorpay-event-id") ||
    `${event.event}:${event.created_at}:${sub?.id ?? ""}`;

  // Idempotency lock: first writer wins; a duplicate insert (unique_violation)
  // means we already handled this event.
  try {
    await withService((db) =>
      db
        .insert(billingWebhookEvents)
        .values({ eventId, eventType: event.event }),
    );
  } catch (dupErr) {
    if (isUniqueViolation(dupErr)) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error("razorpay webhook (marker):", dupErr);
    return NextResponse.json({ error: "marker failed" }, { status: 500 });
  }

  try {
    if (sub?.id && event.event) {
      await processSubscription(event.event, sub);
    }
  } catch (e) {
    // Undo the marker so Razorpay's retry reprocesses this event.
    await withService((db) =>
      db
        .delete(billingWebhookEvents)
        .where(eq(billingWebhookEvents.eventId, eventId)),
    ).catch(() => {});
    console.error(
      "razorpay webhook (process):",
      e instanceof Error ? e.message : e,
    );
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export const POST = handle;

async function processSubscription(eventType: string, sub: RzpSubEntity) {
  const rows = await withService((db) =>
    db
      .select({
        store_id: storeSubscriptions.storeId,
        plan: storeSubscriptions.plan,
        period: storeSubscriptions.period,
        scheduled_plan: storeSubscriptions.scheduledPlan,
        scheduled_period: storeSubscriptions.scheduledPeriod,
      })
      .from(storeSubscriptions)
      .where(eq(storeSubscriptions.rzpSubscriptionId, sub.id))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return; // not one of ours

  const storeId = row.store_id;
  // Period, like plan, is resolved from the plan Razorpay is BILLING — the
  // stored value goes stale the moment a scheduled period change lands, and it
  // feeds the amount printed in the renewal email.
  let period = (row.period ?? "monthly") as "monthly" | "yearly";
  const currentEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;
  const currentStart = sub.current_start
    ? new Date(sub.current_start * 1000)
    : null;

  // The plan Razorpay is actually billing right now — resolved from the
  // subscription's plan_id (authoritative after an upgrade/downgrade), falling
  // back to our stored plan. This is what makes a "change at cycle end" apply
  // only when the real renewal charge lands with the new plan_id.
  let plan = row.plan;
  if (sub.plan_id) {
    const plRows = await withService((db) =>
      db
        .select({ plan: razorpayPlans.plan, period: razorpayPlans.period })
        .from(razorpayPlans)
        .where(eq(razorpayPlans.rzpPlanId, sub.plan_id!))
        .limit(1),
    );
    if (plRows[0]?.plan) plan = plRows[0].plan;
    if (plRows[0]?.period) {
      period = plRows[0].period === "yearly" ? "yearly" : "monthly";
    }
  }
  // A scheduled change is fulfilled once billing actually moves to it. BOTH
  // axes must match: a same-tier period switch never changes the plan, so
  // checking the plan alone would clear the schedule on the next renewal while
  // the period switch was still pending.
  const clearScheduled =
    (!!row.scheduled_plan || !!row.scheduled_period) &&
    (!row.scheduled_plan || plan === row.scheduled_plan) &&
    (!row.scheduled_period || period === row.scheduled_period);

  // Always keep the subscription row's status + cycle window (+ resolved plan)
  // in sync.
  await withService((db) =>
    db
      .update(storeSubscriptions)
      .set({
        status: sub.status,
        plan,
        period,
        ...(clearScheduled
          ? { scheduledPlan: null, scheduledPeriod: null }
          : {}),
        currentStart: currentStart?.toISOString() ?? null,
        currentEnd: currentEnd?.toISOString() ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeSubscriptions.storeId, storeId)),
  );

  let changed = false;
  switch (eventType) {
    // Active / renewed / plan changed → ensure the plan is on and access runs
    // to the paid cycle end.
    case "subscription.authenticated":
    case "subscription.activated":
    case "subscription.charged":
    case "subscription.updated":
      if (currentEnd) {
        changed = await activatePlan(storeId, plan, currentEnd);
      }
      break;

    // A charge failed; Razorpay is retrying. Keep access (still within the paid
    // cycle).
    case "subscription.pending":
      break;

    // Retries exhausted → short grace, then the plan-expiry cron downgrades.
    case "subscription.halted":
      changed = await setExpiry(storeId, addDays(new Date(), GRACE_DAYS));
      break;

    // Cancelled / completed: access remains until current_end (already synced);
    // the cron downgrades to free once it lapses.
    case "subscription.cancelled":
    case "subscription.completed":
      break;

    default:
      break;
  }

  if (changed) revalidateTag(STORE_TAG, "max");

  // Transactional emails (best-effort — a mail failure never fails the webhook).
  await sendLifecycleEmail(storeId, eventType, plan, period, sub, currentEnd);
}

// Which event → which email. Kept out of the state switch so the plan/cycle
// bookkeeping above stays the source of truth regardless of mail.
async function sendLifecycleEmail(
  storeId: string,
  eventType: string,
  plan: string,
  period: "monthly" | "yearly",
  sub: RzpSubEntity,
  currentEnd: Date | null,
) {
  const needsEmail =
    (eventType === "subscription.charged" && (sub.paid_count ?? 0) > 1) ||
    eventType === "subscription.pending" ||
    eventType === "subscription.halted" ||
    eventType === "subscription.cancelled";
  if (!needsEmail) return;

  const recip = await resolveBillingEmail(storeId);
  if (!recip) return;
  const url = manageUrl(recip.slug);
  const meta = PLAN_META[normalizePlan(plan)];
  const amountInr = period === "yearly" ? meta.yearlyInr : meta.monthlyInr;
  const cycleEnd = currentEnd?.toISOString() ?? null;

  switch (eventType) {
    case "subscription.charged": // renewal (first charge is covered by activation)
      await sendBillingEmail(
        recip.email,
        paymentReceiptTemplate({
          storeName: recip.storeName,
          planName: meta.name,
          amountInr,
          period,
          renewsOn: cycleEnd,
          manageUrl: url,
        }),
      );
      break;
    case "subscription.pending":
    case "subscription.halted":
      // In-app record for the dashboard bell; the email is the platform
      // billing one just below (see the note on the registry entry).
      await recordEvent({
        type: "subscription.payment_failed",
        storeId,
        actor: { type: "system", label: "Razorpay" },
        subject: { type: "plan", id: plan, label: meta.name },
        payload: {
          plan: meta.name,
          final: eventType === "subscription.halted",
        },
      });
      await sendBillingEmail(
        recip.email,
        paymentFailedTemplate({
          storeName: recip.storeName,
          planName: meta.name,
          final: eventType === "subscription.halted",
          accessUntil:
            eventType === "subscription.halted"
              ? addDays(new Date(), GRACE_DAYS).toISOString()
              : cycleEnd,
          manageUrl: url,
        }),
      );
      break;
    case "subscription.cancelled":
      await sendBillingEmail(
        recip.email,
        subscriptionCancelledTemplate({
          storeName: recip.storeName,
          planName: meta.name,
          accessUntil: cycleEnd,
          manageUrl: url,
        }),
      );
      break;
  }
}

// Set plan + expiry, UNLESS the store is on an operator comp plan — a comp
// grant must never be overwritten by billing (CODEBASE §15).
async function activatePlan(
  storeId: string,
  plan: string,
  expiresAt: Date,
): Promise<boolean> {
  return withService(async (db) => {
    const storeRows = await db
      .select({ plan: stores.plan, plan_source: stores.planSource })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const store = storeRows[0];
    if (store?.plan_source === "comp") return false;

    const from = store?.plan ?? null;
    await db
      .update(stores)
      .set({
        plan,
        planExpiresAt: expiresAt.toISOString(),
        planSource: "paid",
      })
      .where(eq(stores.id, storeId));

    if (from !== plan) {
      await db.insert(planEvents).values({
        storeId,
        fromPlan: from,
        toPlan: plan,
        source: "paid",
        actor: "subscription-webhook",
        note: "renewal / activation",
      });
    }
    return true;
  });
}

async function setExpiry(storeId: string, expiresAt: Date): Promise<boolean> {
  return withService(async (db) => {
    const storeRows = await db
      .select({ plan_source: stores.planSource })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    if (storeRows[0]?.plan_source === "comp") return false;
    await db
      .update(stores)
      .set({ planExpiresAt: expiresAt.toISOString() })
      .where(eq(stores.id, storeId));
    return true;
  });
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
