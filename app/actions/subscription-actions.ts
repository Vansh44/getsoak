"use server";

// Merchant plan subscriptions (Razorpay autopay). Phase 1: create a
// subscription + collect the mandate, then activate the plan on the client
// callback. Renewals, cancellation and plan changes (Phase 2) run off Razorpay
// webhooks. Billing runs on the PLATFORM's Razorpay account (revenue is
// StoreMink's), never a store's BYO checkout gateway.

import { and, count, eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import {
  admins,
  planEvents,
  storeLocations,
  storeSubscriptions,
  stores,
} from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { STORE_TAG, getCurrentStore } from "@/lib/store/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { PLAN_META, effectivePlan, limitsFor, type Plan } from "@/lib/plans";
import { getExtraLocationPricingLive } from "@/lib/plans/pricing";
import {
  describeLocationChange,
  locationAllowance,
  releasableLocations,
  requiredBilledLocations,
  subscriptionTotalPaise,
  validateBilledLocations,
} from "@/lib/plans/location-billing";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import { logError } from "@/lib/observability/logger";
import {
  rzpCreateSubscription,
  rzpFetchSubscription,
  rzpCancelSubscription,
  rzpUpdateSubscription,
  verifySubscriptionSignature,
} from "@/lib/payments/razorpay";
import {
  resolveRazorpayPlanId,
  totalCyclesFor,
  mandateMaxPaise,
  planAmountPaise,
  amountForRzpPlan,
  type BillingPeriod,
} from "@/lib/payments/subscription";
import {
  billingMayApplyPlan,
  canUpdateSubscription,
  decidePlanChange,
  hasLiveMandate,
  cancelsAtCycleEnd,
} from "@/lib/payments/plan-change";
import {
  resolveBillingEmail,
  sendBillingEmail,
  manageUrl,
  planActivatedTemplate,
} from "@/lib/email/billing-emails";

const PERIODS: BillingPeriod[] = ["monthly", "yearly"];

// Terminal subscription states — no live mandate to cancel/change.
const TERMINAL = new Set(["cancelled", "completed"]);

function isPaidPlan(p: string): p is Exclude<Plan, "free"> {
  return p === "basic" || p === "pro";
}

/**
 * Signup-context authorisation. During signup the store is created on the
 * PLATFORM host, so getActingStoreId() (host-based) can't resolve it — the
 * caller passes the freshly-created store id and we authorise them as its
 * superadmin directly against the admins table. Returns the caller's user id,
 * or null.
 */
async function assertStoreOwner(storeId: string): Promise<string | null> {
  if (typeof storeId !== "string" || !storeId) return null;
  const user = await getServerUser();
  if (!user) return null;
  const rows = await withService((db) =>
    db
      .select({ role: admins.role })
      .from(admins)
      .where(and(eq(admins.id, user.id), eq(admins.storeId, storeId)))
      .limit(1),
  ).catch(() => []);
  return rows[0]?.role === "superadmin" ? user.id : null;
}

export interface SubscriptionState {
  plan: string | null;
  period: BillingPeriod | null;
  status: string | null;
  currentEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: string | null;
  /** True when there's a live mandate the merchant can cancel / change. */
  active: boolean;
}

export async function getSubscriptionState(): Promise<SubscriptionState> {
  const storeId = await getActingStoreId();
  const rows = await withService((db) =>
    db
      .select({
        plan: storeSubscriptions.plan,
        period: storeSubscriptions.period,
        status: storeSubscriptions.status,
        current_end: storeSubscriptions.currentEnd,
        cancel_at_period_end: storeSubscriptions.cancelAtPeriodEnd,
        scheduled_plan: storeSubscriptions.scheduledPlan,
        rzp_subscription_id: storeSubscriptions.rzpSubscriptionId,
        updated_at: storeSubscriptions.updatedAt,
      })
      .from(storeSubscriptions)
      .where(eq(storeSubscriptions.storeId, storeId))
      .limit(1),
  ).catch(() => []);
  const data = rows[0];

  const healed = await reconcileStaleSubscription(storeId, data);
  const status = healed?.status ?? data?.status ?? null;
  const currentEnd = healed?.currentEnd ?? data?.current_end ?? null;

  return {
    plan: data?.plan ?? null,
    period: (data?.period as BillingPeriod) ?? null,
    status,
    currentEnd,
    cancelAtPeriodEnd: !!data?.cancel_at_period_end,
    scheduledPlan: data?.scheduled_plan ?? null,
    active: !!data?.rzp_subscription_id && hasLiveMandate(status),
  };
}

/** How long a `created` row is trusted before we ask the gateway again. */
const RECONCILE_AFTER_MS = 10 * 60 * 1000;

/**
 * Heal a subscription row whose status never moved off `created`.
 *
 * `created` is written when we build the subscription object, BEFORE the
 * merchant sees the mandate screen. Two things normally move it on:
 * confirmSubscription (the client callback) and the Razorpay webhook. Both can
 * be missed — a closed tab or dropped connection loses the callback, and the
 * webhook only heals where it is actually registered and reaching us.
 *
 * When that happens the row says `created` while the mandate is live and
 * charging. That matters because `active` gates the Cancel control: without
 * this, a paying merchant is shown no way to stop autopay, which is a worse
 * failure than the phantom cancel button the allowlist exists to prevent.
 *
 * Deliberately narrow. Only a `created` row with a subscription id is worth
 * asking about — a live or terminal status is already the answer — and the
 * result is throttled, because an abandoned checkout stays `created` for good
 * and would otherwise cost a gateway round-trip on every page view. Best
 * effort throughout: a gateway hiccup returns null and the caller falls back to
 * the stored row.
 */
async function reconcileStaleSubscription(
  storeId: string,
  row:
    | {
        status: string | null;
        current_end: string | null;
        rzp_subscription_id: string | null;
        updated_at: string | null;
      }
    | undefined,
): Promise<{ status: string; currentEnd: string | null } | null> {
  if (!row?.rzp_subscription_id || row.status !== "created") return null;

  const checkedAt = row.updated_at ? Date.parse(row.updated_at) : 0;
  if (checkedAt && Date.now() - checkedAt < RECONCILE_AFTER_MS) return null;

  const creds = getPlatformRazorpayCreds();
  if (!creds) return null;

  const fetched = await rzpFetchSubscription(creds, row.rzp_subscription_id);
  if (!fetched.ok || !fetched.data.status) return null;

  const status = fetched.data.status;
  const currentEnd = fetched.data.current_end
    ? new Date(fetched.data.current_end * 1000).toISOString()
    : row.current_end;

  // Written even when the status is unchanged: updated_at is what throttles the
  // next check, so an abandoned checkout settles into one call per window
  // instead of one per page view.
  await withService((db) =>
    db
      .update(storeSubscriptions)
      .set({ status, currentEnd, updatedAt: new Date().toISOString() })
      .where(eq(storeSubscriptions.storeId, storeId)),
  ).catch((err) => logError("reconcileStaleSubscription", err, { storeId }));

  return { status, currentEnd };
}

export type StartSubscriptionResult =
  | {
      success: true;
      subscriptionId: string;
      keyId: string;
      planName: string;
      amountPaise: number;
    }
  | { error: string };

/**
 * Create a Razorpay Subscription for the chosen paid plan + period and return
 * the params to open the mandate-authorisation checkout. Does NOT change the
 * store's plan — that happens in confirmSubscription after the mandate is
 * authorised (or, in Phase 2, via the webhook).
 */
export async function startPlanSubscription(
  plan: string,
  period: string,
): Promise<StartSubscriptionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  return startPlanSubscriptionForStore(storeId, plan, period);
}

/**
 * Signup-context entry point (see assertStoreOwner). Same subscription flow as
 * the dashboard, but the store is identified explicitly (it doesn't yet resolve
 * from the platform host) and the caller is authorised as its superadmin.
 */
export async function startSignupSubscription(
  storeId: string,
  plan: string,
  period: string,
): Promise<StartSubscriptionResult> {
  const userId = await assertStoreOwner(storeId);
  if (!userId) return { error: "You don't have permission to do this." };
  return startPlanSubscriptionForStore(storeId, plan, period);
}

async function startPlanSubscriptionForStore(
  storeId: string,
  plan: string,
  period: string,
): Promise<StartSubscriptionResult> {
  if (!isPaidPlan(plan)) return { error: "Choose a paid plan to subscribe." };
  if (!PERIODS.includes(period as BillingPeriod)) {
    return { error: "Invalid billing period." };
  }
  const billingPeriod = period as BillingPeriod;

  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { error: "Subscriptions aren't available right now." };
  }

  const resolved = await resolveRazorpayPlanId(plan, billingPeriod);
  if (!resolved) {
    return { error: "Couldn't set up the plan. Please try again." };
  }

  const sub = await rzpCreateSubscription(creds, {
    planId: resolved.rzpPlanId,
    totalCount: totalCyclesFor(billingPeriod),
    notes: { store_id: storeId, plan, period: billingPeriod },
  });
  if (!sub.ok) {
    console.error("startPlanSubscription (create):", sub.error);
    return { error: "Couldn't start the subscription. Please try again." };
  }

  const subFields = {
    plan,
    period: billingPeriod,
    rzpSubscriptionId: sub.data.id,
    rzpPlanId: resolved.rzpPlanId,
    status: sub.data.status || "created",
    mandateMaxPaise: await mandateMaxPaise(),
    cancelAtPeriodEnd: false,
    updatedAt: new Date().toISOString(),
  };
  try {
    // One row per store: upsert keyed on store_id.
    await withService((db) =>
      db
        .insert(storeSubscriptions)
        .values({ storeId, ...subFields })
        .onConflictDoUpdate({
          target: storeSubscriptions.storeId,
          set: subFields,
        }),
    );
  } catch (err) {
    // logError, not console.error: a Drizzle error's message is only "Failed
    // query: …", and the actual reason is on `cause`. Losing it is what turned
    // a missing column into an unexplained "Couldn't start the subscription".
    logError("startPlanSubscription (persist)", err, { storeId, plan });
    return { error: "Couldn't start the subscription. Please try again." };
  }

  return {
    success: true,
    subscriptionId: sub.data.id,
    keyId: creds.keyId,
    planName: PLAN_META[plan].name,
    amountPaise: await planAmountPaise(plan, billingPeriod),
  };
}

export interface ConfirmSubscriptionResult {
  success?: boolean;
  plan?: string;
  error?: string;
}

/**
 * After the merchant authorises the mandate, verify the signature and activate
 * the plan. The store is resolved from the caller's session (not the client),
 * and the subscription id must match the row we created for that store — so a
 * client can't confirm someone else's subscription.
 */
export async function confirmSubscription(
  paymentId: string,
  subscriptionId: string,
  signature: string,
): Promise<ConfirmSubscriptionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  return confirmSubscriptionForStore(
    storeId,
    paymentId,
    subscriptionId,
    signature,
  );
}

/** Signup-context confirm (see assertStoreOwner + startSignupSubscription). */
export async function confirmSignupSubscription(
  storeId: string,
  paymentId: string,
  subscriptionId: string,
  signature: string,
): Promise<ConfirmSubscriptionResult> {
  const userId = await assertStoreOwner(storeId);
  if (!userId) return { error: "You don't have permission to do this." };
  return confirmSubscriptionForStore(
    storeId,
    paymentId,
    subscriptionId,
    signature,
  );
}

async function confirmSubscriptionForStore(
  storeId: string,
  paymentId: string,
  subscriptionId: string,
  signature: string,
): Promise<ConfirmSubscriptionResult> {
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { error: "Subscriptions aren't available right now." };

  if (
    !verifySubscriptionSignature(
      creds.keySecret,
      paymentId,
      subscriptionId,
      signature,
    )
  ) {
    return { error: "Payment verification failed." };
  }

  const subRows = await withService((db) =>
    db
      .select({
        plan: storeSubscriptions.plan,
        period: storeSubscriptions.period,
        rzp_subscription_id: storeSubscriptions.rzpSubscriptionId,
      })
      .from(storeSubscriptions)
      .where(eq(storeSubscriptions.storeId, storeId))
      .limit(1),
  ).catch(() => []);
  const row = subRows[0];
  if (!row || row.rzp_subscription_id !== subscriptionId) {
    return { error: "Subscription not found for this store." };
  }
  const plan = row.plan;
  if (!isPaidPlan(plan)) return { error: "Invalid subscription." };

  // Ask Razorpay for the authoritative state + cycle end (never trust the
  // client for when access should extend to).
  const fetched = await rzpFetchSubscription(creds, subscriptionId);
  const status = fetched.ok ? fetched.data.status : "authenticated";
  const currentEndUnix = fetched.ok ? fetched.data.current_end : null;
  const currentStartUnix = fetched.ok ? fetched.data.current_start : null;

  // Fallback expiry if Razorpay hasn't set current_end yet (first charge still
  // settling) — the Phase 2 webhook corrects it on subscription.charged.
  const period = (row.period as BillingPeriod) ?? "monthly";
  const expiresAt = currentEndUnix
    ? new Date(currentEndUnix * 1000)
    : fallbackExpiry(period);

  // Update the subscription row + activate the plan, atomically.
  let fromPlan: string | null = null;
  try {
    fromPlan = await withService(async (db) => {
      await db
        .update(storeSubscriptions)
        .set({
          status,
          currentStart: currentStartUnix
            ? new Date(currentStartUnix * 1000).toISOString()
            : null,
          currentEnd: expiresAt.toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(storeSubscriptions.storeId, storeId));

      // Activate the plan (idempotent — re-confirm just re-sets the same values).
      const curRows = await db
        .select({ plan: stores.plan })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);

      await db
        .update(stores)
        .set({
          plan,
          planExpiresAt: expiresAt.toISOString(),
          planSource: "paid",
        })
        .where(eq(stores.id, storeId));

      return curRows[0]?.plan ?? null;
    });
  } catch (err) {
    console.error(
      "confirmSubscription (plan):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Payment succeeded but activating the plan failed." };
  }

  // Audit trail — best effort, and in its OWN transaction so it CANNOT roll
  // back the activation. It used to sit in the txn above writing
  // `source: "paid"`, which the plan_events CHECK (operator|billing|system)
  // rejects: every confirm threw here and undid the plan the merchant had just
  // been charged for, reporting "Payment succeeded but activating the plan
  // failed."
  try {
    await withService((db) =>
      db.insert(planEvents).values({
        storeId,
        fromPlan,
        toPlan: plan,
        source: "billing",
        actor: "subscription",
        note: `subscription ${subscriptionId} activated (${period})`,
      }),
    );
  } catch (auditErr) {
    logError("confirmSubscription (audit)", auditErr, { storeId, plan });
  }

  revalidateTag(STORE_TAG, "max");

  emitEvent({
    type: "plan.changed",
    storeId,
    actor: { type: "system", label: "Subscription" },
    subject: { type: "plan", id: plan, label: PLAN_META[plan].name },
    payload: { plan, note: `Activated for ${period}` },
  });

  // Welcome / activation email (best-effort — never blocks activation).
  const recip = await resolveBillingEmail(storeId);
  if (recip) {
    await sendBillingEmail(
      recip.email,
      planActivatedTemplate({
        storeName: recip.storeName,
        planName: PLAN_META[plan].name,
        amountInr: (await planAmountPaise(plan, period)) / 100,
        period,
        renewsOn: expiresAt.toISOString(),
        manageUrl: manageUrl(recip.slug),
      }),
    );
  }

  return { success: true, plan };
}

function fallbackExpiry(period: BillingPeriod): Date {
  const d = new Date();
  if (period === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

export interface SubscriptionActionResult {
  success?: boolean;
  error?: string;
  message?: string;
}

/**
 * Cancel the autopay subscription at the END of the current paid cycle: no
 * further money is deducted, access continues until the cycle ends, then the
 * plan-expiry cron downgrades the store to free. Cancelling is idempotent.
 */
export async function cancelSubscription(): Promise<SubscriptionActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };

  const creds = getPlatformRazorpayCreds();
  if (!creds) return { error: "Subscriptions aren't available right now." };

  const storeId = await getActingStoreId();
  const rows = await withService((db) =>
    db
      .select({
        rzp_subscription_id: storeSubscriptions.rzpSubscriptionId,
        status: storeSubscriptions.status,
        current_end: storeSubscriptions.currentEnd,
      })
      .from(storeSubscriptions)
      .where(eq(storeSubscriptions.storeId, storeId))
      .limit(1),
  ).catch(() => []);
  const row = rows[0];

  if (!row?.rzp_subscription_id) {
    return { error: "No active subscription to cancel." };
  }
  if (TERMINAL.has(row.status ?? "")) {
    return { error: "This subscription is already cancelled." };
  }

  // ── Cancel at cycle end, or now? The subscription's own state decides. ────
  //
  // `cancel_at_cycle_end = 1` means "stop future charges, keep what they paid
  // for" — and Razorpay REFUSES it when no cycle is running:
  //     "Subscription cannot be cancelled since no billing cycle is going on"
  // which surfaced to the merchant as "Couldn't cancel the subscription."
  // with no way forward. A cycle only exists once a charge has been made, so
  // this hits any subscription cancelled between authorising the mandate and
  // the first payment — not just abandoned ones.
  //
  // With nothing paid for, an immediate cancel takes nothing away, so the two
  // branches mean the same thing to the merchant: no more money leaves.
  const cycleRunning = cancelsAtCycleEnd(row.status, row.current_end);

  let res = await rzpCancelSubscription(
    creds,
    row.rzp_subscription_id,
    cycleRunning,
  );

  // Our status can lag the gateway (it moves on webhooks), so believe Razorpay
  // over the local row rather than dead-ending the merchant on stale data.
  if (!res.ok && cycleRunning && /billing cycle/i.test(res.error ?? "")) {
    res = await rzpCancelSubscription(creds, row.rzp_subscription_id, false);
  }

  if (!res.ok) {
    logError("cancelSubscription", res.error, {
      storeId,
      status: row.status,
      cycleRunning,
    });
    return { error: "Couldn't cancel the subscription. Please try again." };
  }

  // Record what actually happened. Writing cancelAtPeriodEnd on an immediate
  // cancel would have the card promise access until a cycle end that isn't
  // coming.
  const endedNow = !cycleRunning;
  await withService((db) =>
    db
      .update(storeSubscriptions)
      .set({
        cancelAtPeriodEnd: !endedNow,
        status: res.data.status || (endedNow ? "cancelled" : "active"),
        scheduledPlan: null,
        scheduledPeriod: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeSubscriptions.storeId, storeId)),
  ).catch((err) => logError("cancelSubscription (persist)", err, { storeId }));

  // Access + plan_expires_at are left as-is either way: on a cycle-end cancel
  // the store keeps its plan until the cycle runs out and the cron downgrades
  // it; on an immediate cancel there was no subscription-granted access to
  // remove (an operator comp, if any, is not ours to revoke here).
  return {
    success: true,
    message: endedNow
      ? "Autopay cancelled. No payments will be taken."
      : "Autopay cancelled. You keep your plan until the cycle ends.",
  };
}

/**
 * Change the plan of an EXISTING subscription (e.g. basic → pro) on the same
 * mandate. `when`:
 *   "now"        → prorate + reset the cycle immediately (activated now; the
 *                  webhook confirms the new expiry).
 *   "cycle_end"  → the new plan starts at the next renewal (recorded as a
 *                  scheduled change; the webhook applies it when it bills).
 */
/**
 * Move an existing subscription to a different plan and/or billing period.
 *
 * WHEN it takes effect is DERIVED, never passed in: dearer applies now with
 * Razorpay prorating the difference, cheaper waits for the paid cycle to run
 * out. See lib/payments/plan-change.ts for why the merchant does not get to
 * choose (short version: "apply now" on a downgrade means refunding money
 * they already paid, and refunds are the messiest thing in billing).
 */
export async function changePlan(
  targetPlan: string,
  targetPeriodRaw: string,
): Promise<SubscriptionActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };

  if (!isPaidPlan(targetPlan)) return { error: "Choose a paid plan." };
  const targetPeriod: BillingPeriod =
    targetPeriodRaw === "yearly" ? "yearly" : "monthly";

  const creds = getPlatformRazorpayCreds();
  if (!creds) return { error: "Subscriptions aren't available right now." };

  const storeId = await getActingStoreId();
  const rows = await withService((db) =>
    db
      .select({
        rzp_subscription_id: storeSubscriptions.rzpSubscriptionId,
        rzp_plan_id: storeSubscriptions.rzpPlanId,
        plan: storeSubscriptions.plan,
        period: storeSubscriptions.period,
        status: storeSubscriptions.status,
        mandate_max_paise: storeSubscriptions.mandateMaxPaise,
        billed_locations: storeSubscriptions.billedLocations,
      })
      .from(storeSubscriptions)
      .where(eq(storeSubscriptions.storeId, storeId))
      .limit(1),
  ).catch(() => []);
  const row = rows[0];

  if (!row?.rzp_subscription_id) {
    return { error: "No active subscription to change." };
  }
  // Razorpay only updates `authenticated` and `active` subscriptions. Checking
  // here turns a raw gateway error into an explanation — and `halted`/`pending`
  // mean a payment failed, which is exactly when someone comes to downgrade.
  const usable = canUpdateSubscription(row.status);
  if (!usable.ok) return { error: usable.reason! };

  const currentPeriod: BillingPeriod =
    row.period === "yearly" ? "yearly" : "monthly";

  // What they pay TODAY — read from the Razorpay plan actually attached to the
  // subscription, not from the catalog, because a subscriber may be
  // grandfathered on an older price. Falling back to the catalog only if that
  // lookup fails.
  const currentAmountPaise =
    (await amountForRzpPlan(row.rzp_plan_id)) ??
    (await planAmountPaise(row.plan as Plan, currentPeriod));

  // ★ METERED LOCATIONS RIDE ALONG (roadmap Step 5). Their cost is folded into
  // the subscription amount, so resolving the target plan WITHOUT them would
  // quietly drop the merchant back to the bare tier price while they keep every
  // shop — a revenue leak invisible on both sides, and one that would surface
  // months later as "why is my invoice smaller than my location list".
  //
  // Zero when the TARGET tier has no POS: leaving Pro means the locations stop
  // working, and charging for something the plan cannot use is indefensible.
  // The stored count is deliberately NOT written back here — it records what
  // the store has bought, so returning to Pro resumes billing for the shops it
  // still holds rather than handing them over free.
  const targetHasPos = limitsFor(targetPlan).posLocationsIncluded > 0;
  const billedLocations = targetHasPos ? (row.billed_locations ?? 0) : 0;
  const targetAmountPaise = subscriptionTotalPaise(
    await planAmountPaise(targetPlan, targetPeriod),
    billedLocations,
    targetPeriod,
    await getExtraLocationPricingLive(),
  );

  const decision = decidePlanChange({
    currentPlan: row.plan,
    currentPeriod,
    currentAmountPaise,
    targetPlan,
    targetPeriod,
    targetAmountPaise,
  });
  if (decision.kind === "noop") return { error: decision.reason };

  // A charge above the authorised mandate cannot be auto-debited. Only an
  // increase can trip this, so it is checked only when one is happening.
  const mandateMax = row.mandate_max_paise ?? 0;
  if (decision.immediate && mandateMax > 0 && targetAmountPaise > mandateMax) {
    return {
      error:
        "This plan costs more than your autopay limit allows. Cancel your current subscription and subscribe again to authorise the higher amount.",
    };
  }

  const resolved = await resolveRazorpayPlanId(
    targetPlan,
    targetPeriod,
    billedLocations,
  );
  if (!resolved)
    return { error: "Couldn't set up the plan. Please try again." };

  const res = await rzpUpdateSubscription(creds, row.rzp_subscription_id, {
    planId: resolved.rzpPlanId,
    scheduleChangeAt: decision.when,
  });
  if (!res.ok) {
    console.error("changePlan:", res.error);
    return { error: "Couldn't change the plan. Please try again." };
  }

  const targetName = PLAN_META[targetPlan].name;

  if (decision.immediate) {
    // Applied now: reflect it (the webhook remains the authority on expiry).
    const currentEnd = res.data.current_end
      ? new Date(res.data.current_end * 1000)
      : fallbackExpiry(targetPeriod);

    let applied: { from: string | null } | null = null;
    try {
      applied = await withService(async (db) => {
        await db
          .update(storeSubscriptions)
          .set({
            plan: targetPlan,
            period: targetPeriod,
            rzpPlanId: resolved.rzpPlanId,
            scheduledPlan: null,
            scheduledPeriod: null,
            currentEnd: currentEnd.toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(storeSubscriptions.storeId, storeId));

        const curRows = await db
          .select({ plan: stores.plan, plan_source: stores.planSource })
          .from(stores)
          .where(eq(stores.id, storeId))
          .limit(1);
        const cur = curRows[0];
        // A comp is a floor billing may raise, never lower (see
        // billingMayApplyPlan). An unconditional refusal here meant a comped
        // store was charged the upgrade and kept its old plan.
        if (!billingMayApplyPlan(cur?.plan, cur?.plan_source, targetPlan)) {
          return null;
        }
        await db
          .update(stores)
          .set({
            plan: targetPlan,
            planExpiresAt: currentEnd.toISOString(),
            planSource: "paid",
          })
          .where(eq(stores.id, storeId));
        return { from: cur?.plan ?? null };
      });
    } catch (err) {
      logError("changePlan (persist now)", err, { storeId, targetPlan });
    }

    // The money has already moved at Razorpay, so never report a bare success
    // when the plan did not actually change — that is how a merchant is shown
    // "You're now on the Pro plan" over a store still on basic.
    if (!applied) {
      return {
        error:
          "Your payment went through but the plan didn't switch over. Please contact support — you won't be charged again.",
      };
    }

    revalidateTag(STORE_TAG, "max");

    // Audit trail — own transaction, so it can't roll back the activation.
    try {
      await withService((db) =>
        db.insert(planEvents).values({
          storeId,
          fromPlan: applied.from,
          toPlan: targetPlan,
          source: "billing",
          actor: "subscription",
          note: `plan change (now, ${targetPeriod})`,
        }),
      );
    } catch (auditErr) {
      logError("changePlan (audit)", auditErr, { storeId, targetPlan });
    }

    return {
      success: true,
      message: decision.periodChanged
        ? `You're on ${targetName}, billed ${targetPeriod}.`
        : `You're now on the ${targetName} plan.`,
    };
  }

  // Scheduled for cycle end — record BOTH axes; the webhook applies whichever
  // actually moved when the renewal charge lands.
  await withService((db) =>
    db
      .update(storeSubscriptions)
      .set({
        scheduledPlan: targetPlan,
        scheduledPeriod: targetPeriod,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeSubscriptions.storeId, storeId)),
  ).catch((err) => console.error("changePlan (persist scheduled):", err));
  return {
    success: true,
    message: decision.periodChanged
      ? `${targetName} billed ${targetPeriod} starts at your next renewal. Nothing is charged today.`
      : `${targetName} will start at your next renewal. Nothing is charged today.`,
  };
}

// ---------------------------------------------------------------------------
// Metered extra POS locations (roadmap Step 5 / POS Phase 7).
//
// An extra location is a PRICE RISE ON THE SAME SUBSCRIPTION, not a second one
// — see lib/plans/location-billing.ts for why. That means this reuses
// `changePlan`'s whole apparatus: the same mandate, the same
// dearer-now/cheaper-at-cycle-end rule, the same updatable-state check.
// ---------------------------------------------------------------------------

export interface LocationBillingState {
  /** Locations the plan includes at no extra cost. */
  included: number;
  /** Extra locations currently paid for. */
  billed: number;
  /** Locations that exist right now. */
  existing: number;
  /** included + billed — the ceiling createLocation enforces. */
  allowance: number;
  /** Extra locations that MUST stay paid for, given what exists. */
  required: number;
  /** Paid slots sitting unused, which could be released. */
  releasable: number;
  pricePerPeriodInr: number;
  period: BillingPeriod;
  /** Can the merchant buy one right now? False when there is no live mandate. */
  canBuy: boolean;
  /** Why not, when canBuy is false. */
  blockedReason?: string;
}

/**
 * What the Locations page needs to render the billing card. Read-only, so it is
 * gated on VIEW of the section the merchant is looking at rather than on
 * billing permissions.
 */
export async function getLocationBillingState(): Promise<LocationBillingState | null> {
  const userId = await getManagerUserId("locations");
  if (!userId) return null;
  const storeId = await getActingStoreId();

  const [store, subRows, locRows, locationPrice] = await Promise.all([
    getCurrentStore(),
    withService((db) =>
      db
        .select({
          status: storeSubscriptions.status,
          period: storeSubscriptions.period,
          billed_locations: storeSubscriptions.billedLocations,
          mandate_max_paise: storeSubscriptions.mandateMaxPaise,
        })
        .from(storeSubscriptions)
        .where(eq(storeSubscriptions.storeId, storeId))
        .limit(1),
    ).catch(() => []),
    withService((db) =>
      db
        .select({ n: count() })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId)),
    ).catch(() => [{ n: 0 }]),
    getExtraLocationPricingLive(),
  ]);

  const plan = effectivePlan(store);
  const sub = subRows[0];
  const billed = sub?.billed_locations ?? 0;
  const existing = locRows[0]?.n ?? 0;
  const period: BillingPeriod = sub?.period === "yearly" ? "yearly" : "monthly";

  // Buying folds the cost into the subscription, so there has to BE one. A
  // comped Pro store has no mandate to raise — telling them plainly beats a
  // button that fails at the gateway.
  let blockedReason: string | undefined;
  if (limitsFor(plan).posLocationsIncluded <= 0) {
    blockedReason = "Extra locations are part of the Pro plan.";
  } else if (!hasLiveMandate(sub?.status)) {
    blockedReason =
      "Extra locations are billed through your subscription. Set up autopay to add more shops.";
  } else if (!canUpdateSubscription(sub?.status).ok) {
    blockedReason = canUpdateSubscription(sub?.status).reason;
  }

  return {
    included: limitsFor(plan).posLocationsIncluded,
    billed,
    existing,
    allowance: locationAllowance(plan, billed),
    required: requiredBilledLocations(plan, existing),
    releasable: releasableLocations(plan, billed, existing),
    // The operator-set price (plan_prices, key `extra_location`), falling back
    // to the code constant when none has been set. Cached is right here — this
    // number is DISPLAYED; the charge re-reads it live.
    pricePerPeriodInr:
      period === "yearly" ? locationPrice.yearlyInr : locationPrice.monthlyInr,
    period,
    canBuy: !blockedReason,
    blockedReason,
  };
}

/**
 * Set how many EXTRA locations the store pays for.
 *
 * Absolute, not a delta: two tabs each pressing "add one" against a delta would
 * buy two, and the merchant would find out on their card. An absolute target is
 * idempotent — the second request resolves to the same number and no-ops.
 */
export async function changeBilledLocations(
  requested: number,
): Promise<SubscriptionActionResult> {
  // Buying a location spends money, so it is the same gate the rest of billing
  // uses, not the `locations` section that merely manages shops.
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };

  const creds = getPlatformRazorpayCreds();
  if (!creds) return { error: "Subscriptions aren't available right now." };

  const storeId = await getActingStoreId();
  const store = await getCurrentStore();
  const plan = effectivePlan(store);

  const [subRows, locRows] = await Promise.all([
    withService((db) =>
      db
        .select({
          rzp_subscription_id: storeSubscriptions.rzpSubscriptionId,
          rzp_plan_id: storeSubscriptions.rzpPlanId,
          plan: storeSubscriptions.plan,
          period: storeSubscriptions.period,
          status: storeSubscriptions.status,
          mandate_max_paise: storeSubscriptions.mandateMaxPaise,
          billed_locations: storeSubscriptions.billedLocations,
        })
        .from(storeSubscriptions)
        .where(eq(storeSubscriptions.storeId, storeId))
        .limit(1),
    ).catch(() => []),
    withService((db) =>
      db
        .select({ n: count() })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId)),
    ).catch(() => [{ n: 0 }]),
  ]);

  const row = subRows[0];
  if (!row?.rzp_subscription_id) {
    return {
      error:
        "Extra locations are billed through your subscription. Set up autopay first.",
    };
  }
  const usable = canUpdateSubscription(row.status);
  if (!usable.ok) return { error: usable.reason! };

  const existing = locRows[0]?.n ?? 0;
  const check = validateBilledLocations(plan, requested, existing);
  if (!check.ok) return { error: check.reason };

  const current = row.billed_locations ?? 0;
  if (check.count === current) {
    return { error: "That's already how many extra locations you have." };
  }

  const period: BillingPeriod = row.period === "yearly" ? "yearly" : "monthly";
  const planPaise = await planAmountPaise(row.plan as Plan, period);
  // LIVE — this decides what is debited from a mandate that is already
  // authorised, so it must never come from a cache a reprice has not reached.
  const locationPrice = await getExtraLocationPricingLive();
  const targetAmountPaise = subscriptionTotalPaise(
    planPaise,
    check.count,
    period,
    locationPrice,
  );
  // The FALLBACK is priced at today's rate too, but only as a last resort:
  // amountForRzpPlan reports what this subscriber actually pays, which may be a
  // grandfathered rate from before an operator repriced.
  const currentAmountPaise =
    (await amountForRzpPlan(row.rzp_plan_id)) ??
    subscriptionTotalPaise(planPaise, current, period, locationPrice);

  // Same rule as a tier change, and for the same reason: buying is dearer so it
  // prorates now; releasing is cheaper so it waits for the cycle they already
  // paid for. Nobody is refunded, so no refund can go wrong.
  const immediate = targetAmountPaise > currentAmountPaise;

  // ★ CHECKED BEFORE THE GATEWAY, because the mandate ceiling was fixed when the
  // merchant authorised autopay and cannot be raised without them re-authorising.
  // Razorpay would accept the plan change and then fail the DEBIT weeks later,
  // which surfaces as a halted subscription rather than as "you can't buy this".
  const mandateMax = row.mandate_max_paise ?? 0;
  if (immediate && mandateMax > 0 && targetAmountPaise > mandateMax) {
    return {
      error:
        "That's more than your autopay limit allows. Cancel your subscription and subscribe again to authorise a higher amount.",
    };
  }

  const resolved = await resolveRazorpayPlanId(
    row.plan as Plan,
    period,
    check.count,
  );
  if (!resolved) {
    return { error: "Couldn't price the change. Please try again." };
  }

  const res = await rzpUpdateSubscription(creds, row.rzp_subscription_id, {
    planId: resolved.rzpPlanId,
    scheduleChangeAt: immediate ? "now" : "cycle_end",
  });
  if (!res.ok) {
    logError("changeBilledLocations (gateway)", res.error, {
      storeId,
      requested: check.count,
    });
    return { error: "Couldn't update your subscription. Please try again." };
  }

  // ★ THE COUNT IS ONLY WRITTEN WHEN IT IS LIVE. Persisting a scheduled RELEASE
  // now would drop the allowance immediately, and a store sitting exactly on its
  // ceiling would find it could no longer create the location it is still paying
  // for until the end of the cycle. The webhook resolves the tier from the plan
  // id Razorpay actually bills; this column follows on the same edge.
  if (immediate) {
    try {
      await withService((db) =>
        db
          .update(storeSubscriptions)
          .set({
            billedLocations: check.count,
            rzpPlanId: resolved.rzpPlanId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(storeSubscriptions.storeId, storeId)),
      );
    } catch (err) {
      // The gateway has already been told, and on an increase the merchant has
      // been charged. Never report a bare success when the record did not move
      // — that is how someone pays for a location the cap still refuses them
      // (the §15b "never report a bare success" rule).
      logError("changeBilledLocations (persist)", err, {
        storeId,
        requested: check.count,
      });
      return {
        error:
          "Your payment went through but we couldn't finish setting up the location. Contact support and we'll sort it out — don't try again.",
      };
    }
    revalidateTag(STORE_TAG, "max");
  }

  emitEvent({
    type: "plan.changed",
    storeId,
    actor: { type: "admin", id: userId, label: null },
    subject: { type: "store", id: storeId, label: null },
    payload: {
      extraLocations: check.count,
      previousExtraLocations: current,
    },
  });

  return {
    success: true,
    message: describeLocationChange(
      current,
      check.count,
      period,
      locationPrice,
    ),
  };
}
