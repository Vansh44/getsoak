"use server";

// Merchant plan subscriptions (Razorpay autopay). Phase 1: create a
// subscription + collect the mandate, then activate the plan on the client
// callback. Renewals, cancellation and plan changes (Phase 2) run off Razorpay
// webhooks. Billing runs on the PLATFORM's Razorpay account (revenue is
// StoreMink's), never a store's BYO checkout gateway.

import { and, eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import {
  admins,
  planEvents,
  storeSubscriptions,
  stores,
} from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { STORE_TAG } from "@/lib/store/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { PLAN_META, type Plan } from "@/lib/plans";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
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
  canUpdateSubscription,
  decidePlanChange,
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
      })
      .from(storeSubscriptions)
      .where(eq(storeSubscriptions.storeId, storeId))
      .limit(1),
  ).catch(() => []);
  const data = rows[0];
  const status = data?.status ?? null;
  return {
    plan: data?.plan ?? null,
    period: (data?.period as BillingPeriod) ?? null,
    status,
    currentEnd: data?.current_end ?? null,
    cancelAtPeriodEnd: !!data?.cancel_at_period_end,
    scheduledPlan: data?.scheduled_plan ?? null,
    active: !!data?.rzp_subscription_id && !TERMINAL.has(status ?? ""),
  };
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
    console.error(
      "startPlanSubscription (persist):",
      err instanceof Error ? err.message : err,
    );
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

  // Update the subscription row + activate the plan + audit, atomically.
  try {
    await withService(async (db) => {
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

      // Audit trail (best-effort, same txn).
      await db.insert(planEvents).values({
        storeId,
        fromPlan: curRows[0]?.plan ?? null,
        toPlan: plan,
        source: "paid",
        actor: "subscription",
        note: `subscription ${subscriptionId} activated (${period})`,
      });
    });
  } catch (err) {
    console.error(
      "confirmSubscription (plan):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Payment succeeded but activating the plan failed." };
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

  // cancel_at_cycle_end = true → stop future charges, keep access to cycle end.
  const res = await rzpCancelSubscription(creds, row.rzp_subscription_id, true);
  if (!res.ok) {
    console.error("cancelSubscription:", res.error);
    return { error: "Couldn't cancel the subscription. Please try again." };
  }

  await withService((db) =>
    db
      .update(storeSubscriptions)
      .set({
        cancelAtPeriodEnd: true,
        status: res.data.status || "active",
        scheduledPlan: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeSubscriptions.storeId, storeId)),
  ).catch((err) => console.error("cancelSubscription (persist):", err));

  // Access + plan_expires_at are left as-is: the store keeps its plan until the
  // paid cycle ends, then the cron downgrades to free.
  return {
    success: true,
    message: "Autopay cancelled. You keep your plan until the cycle ends.",
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
  const targetAmountPaise = await planAmountPaise(targetPlan, targetPeriod);

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

  const resolved = await resolveRazorpayPlanId(targetPlan, targetPeriod);
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

    let planActivated = false;
    try {
      planActivated = await withService(async (db) => {
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
        // An operator comp must never be overwritten by a billing change.
        if (cur?.plan_source === "comp") return false;
        await db
          .update(stores)
          .set({
            plan: targetPlan,
            planExpiresAt: currentEnd.toISOString(),
            planSource: "paid",
          })
          .where(eq(stores.id, storeId));
        await db.insert(planEvents).values({
          storeId,
          fromPlan: cur?.plan ?? null,
          toPlan: targetPlan,
          source: "paid",
          actor: "subscription",
          note: `plan change (now, ${targetPeriod})`,
        });
        return true;
      });
    } catch (err) {
      console.error("changePlan (persist now):", err);
    }
    if (planActivated) revalidateTag(STORE_TAG, "max");
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
