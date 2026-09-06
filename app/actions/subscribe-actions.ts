"use server";

/**
 * Subscribing to a plan, on the new billing system (§34).
 *
 * ⚠ EVERY EXPORT OF THIS FILE IS A PUBLICLY REACHABLE ENDPOINT. That is what
 * makes the gate on each one load-bearing rather than decorative: these take a
 * merchant's money and change what their store is entitled to.
 *
 * ★ THE ONLY BILLING PATH. `subscription-actions.ts` and the Razorpay
 * Subscriptions machinery behind it were deleted on 2026-08-13 — StoreMink owns
 * the amount and the schedule now, so nothing here asks a provider to change a
 * plan (which is the call that never worked on UPI or e-mandate).
 */

import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { getActingStoreId, getManagerUserId } from "@/app/dashboard/lib/access";
import { withService } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { getCurrentStore, STORE_TAG } from "@/lib/store/resolve";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
} from "@/lib/plans/pricing";
import { PLAN_IDS, PLAN_META, type Plan } from "@/lib/plans";
import type {
  LocationBillingState,
  PayableInvoice,
  SubscriptionView,
} from "@/lib/billing/invoice-types";
import {
  confirmInvoicePayment,
  listPayableInvoices,
  startInvoicePayment,
  type PaymentStart,
} from "@/lib/billing/manual-pay";
import {
  cancelAtPeriodEnd,
  getSubscriptionView,
  resumeSubscription,
} from "@/lib/billing/cancel";
import { confirmPlanChange, startPlanChange } from "@/lib/billing/plan-change";
import {
  confirmLocationPurchase,
  getLocationBillingState as readLocationBillingState,
  releaseLocations,
  startLocationPurchase,
} from "@/lib/billing/locations";
import {
  auditEnrolment,
  confirmEnrolment,
  ensureBillingAccount,
  startEnrolment,
  type EnrolmentStart,
} from "@/lib/billing/enrol";
import { normalizeMandateMethod } from "@/lib/billing/mandate-types";

type BillingPeriod = "monthly" | "yearly";

export type SubscribeStart =
  | ({ ok: true } & EnrolmentStart)
  | { ok: false; error: string };

export type SubscribeConfirm =
  | { ok: true; plan: Plan; periodEnd: string; autopay: boolean }
  | { ok: false; error: string };

/**
 * Prices, read LIVE.
 *
 * ★ Never the cached readers — this number becomes a charge, and a cache an
 * operator's reprice has not reached would bill the old amount.
 */
async function priceFor(plan: Plan, period: BillingPeriod) {
  const [pricing, locationPrice] = await Promise.all([
    getPlanPricingLive(),
    getExtraLocationPricingLive(),
  ]);
  const row = pricing[plan];
  return {
    planPaise: Math.round(
      (period === "yearly" ? row.yearlyInr : row.monthlyInr) * 100,
    ),
    locationPaise: Math.round(
      (period === "yearly"
        ? locationPrice.yearlyInr
        : locationPrice.monthlyInr) * 100,
    ),
  };
}

function isPaidPlan(plan: unknown): plan is Plan {
  return plan === "basic" || plan === "pro";
}

/**
 * Begin subscribing: issue the first invoice and open a Razorpay order.
 *
 * The merchant's plan does NOT change here — `confirmSubscribe` does that, and
 * only against a verified payment.
 */
export async function startSubscribe(
  plan: unknown,
  period: unknown,
  /**
   * Which rail to authorise the mandate on — "card" or "upi".
   *
   * ★ Accepting this from the browser is safe in a way an amount would not be:
   * it selects a payment RAIL, every figure is still computed server-side, and
   * `normalizeMandateMethod` coerces anything unrecognised to "card". It has to
   * be a parameter because Razorpay fixes the rail on the ORDER, so Checkout
   * cannot offer the choice itself.
   */
  mandateMethod?: unknown,
): Promise<SubscribeStart> {
  // Paid enrolment begins only after the dashboard has resolved both the
  // signed-in manager and the store tenant from the store host.
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  return startSubscribeForStore(
    await getActingStoreId(),
    plan,
    period,
    mandateMethod,
  );
}

/**
 * Core dashboard enrolment after access and tenant resolution. Signup always
 * creates Free stores and never reaches billing; upgrades begin from the
 * store-host Plans & Billing page.
 */
async function startSubscribeForStore(
  storeId: string,
  plan: unknown,
  period: unknown,
  mandateMethod?: unknown,
): Promise<SubscribeStart> {
  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "Choose a paid plan." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";

  // Best-effort: an invoice can be issued without a billing profile, and
  // blocking a sale on optional identity fields would be the wrong trade.
  await ensureBillingAccount(storeId);

  const started = await startEnrolment({
    storeId,
    plan,
    period: billingPeriod,
    mandateMethod: normalizeMandateMethod(mandateMethod),
    priceFor,
  });
  if (!started.ok) return { ok: false, error: started.error };
  return { ok: true, ...started.data };
}

/**
 * Finish subscribing after the merchant's payment.
 *
 * ★ The signature is verified server-side inside `confirmEnrolment`, against the
 * order WE created. Nothing the client sends is trusted on its own.
 */
export async function confirmSubscribe(
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<SubscribeConfirm> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  return confirmSubscribeForStore(
    await getActingStoreId(),
    invoiceId,
    providerPaymentId,
    signature,
  );
}

/** ★ THE CORE — the payment result is verified before entitlement changes. */
async function confirmSubscribeForStore(
  storeId: string,
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<SubscribeConfirm> {
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }

  // Read the plan BEFORE activation so the audit row can name what it moved
  // from. Best-effort: a missing `from` is a worse audit row, not a reason to
  // refuse a payment that has already happened.
  let fromPlan: string | null = null;
  try {
    fromPlan = await withService(async (db) => {
      const [row] = await db
        .select({ plan: stores.plan })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      return row?.plan ?? null;
    });
  } catch {
    fromPlan = null;
  }

  const confirmed = await confirmEnrolment({
    storeId,
    invoiceId,
    providerPaymentId,
    signature,
  });
  if (!confirmed.ok) return { ok: false, error: confirmed.error };

  // ★ Audit in its own transaction, with source:"billing" — see auditEnrolment
  // for why the wrong value once rolled back the plan a merchant had paid for.
  await auditEnrolment({
    storeId,
    fromPlan,
    toPlan: confirmed.data.plan,
    note: `subscribed (${confirmed.data.mandateActivated ? "autopay" : "manual renewal"})`,
  });

  // Every plan gate reads the cached store row.
  revalidateTag(STORE_TAG, "max");

  return {
    ok: true,
    plan: confirmed.data.plan,
    periodEnd: confirmed.data.periodEnd,
    autopay: confirmed.data.mandateActivated,
  };
}

// ---------------------------------------------------------------------------
// Manual payment — settling an invoice the merchant already owes.
//
// A first-class fallback for renewals above the AFA limit, revoked/missing
// mandates, and provider incidents. New enrolments no longer enter this path by
// silently accepting a one-time first payment: they must authorise autopay.
// ---------------------------------------------------------------------------

export type PayInvoiceStart =
  | ({ ok: true } & PaymentStart)
  | { ok: false; error: string };

export type PayInvoiceConfirm =
  | { ok: true; planRestored: boolean }
  | { ok: false; error: string };

/** What this store still owes, for a "pay now" surface. */
export async function getPayableInvoices(): Promise<PayableInvoice[]> {
  const userId = await getManagerUserId("ai");
  if (!userId) return [];
  const storeId = await getActingStoreId();
  return listPayableInvoices(storeId);
}

export async function startPayInvoice(
  invoiceId: unknown,
): Promise<PayInvoiceStart> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (typeof invoiceId !== "string" || !invoiceId) {
    return { ok: false, error: "We couldn't find that invoice." };
  }

  // ★ The store comes from the SESSION, never the caller. startInvoicePayment
  // then refuses any invoice that does not belong to it, so an invoice id from
  // another tenant finds nothing rather than becoming payable.
  const storeId = await getActingStoreId();
  const started = await startInvoicePayment({ storeId, invoiceId });
  if (!started.ok) return { ok: false, error: started.error };
  return { ok: true, ...started.data };
}

export async function confirmPayInvoice(
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<PayInvoiceConfirm> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }

  const storeId = await getActingStoreId();
  const done = await confirmInvoicePayment({
    storeId,
    invoiceId,
    providerPaymentId,
    signature,
  });
  if (!done.ok) return { ok: false, error: done.error };

  // A restored plan changes entitlement, so every gate must see it.
  if (done.data.planRestored) revalidateTag(STORE_TAG, "max");

  return { ok: true, planRestored: done.data.planRestored };
}

// ---------------------------------------------------------------------------
// Extra locations — metered, and billed WITH the subscription (§34, POS 7).
//
// ★ The old path did this with `rzpUpdateSubscription`, which Razorpay does not
// support for UPI or e-mandate mandates — so for most Indian merchants buying a
// location silently did not work. Here StoreMink prices it: the part period is a
// one-off payment on the verified checkout, and every future cycle is billed from
// `billed_locations` by the renewal worker.
// ---------------------------------------------------------------------------

/** Read-only, so gated on VIEW of the section the merchant is looking at. */
export async function getLocationBilling(): Promise<LocationBillingState | null> {
  const userId = await getManagerUserId("locations");
  if (!userId) return null;
  const [storeId, store, locationPrice] = await Promise.all([
    getActingStoreId(),
    getCurrentStore(),
    getExtraLocationPricingLive(),
  ]);
  return readLocationBillingState({ storeId, store, locationPrice });
}

export type LocationPurchaseResult =
  | {
      ok: true;
      invoiceId: string;
      providerOrderId: string;
      keyId: string;
      amountPaise: number;
      targetCount: number;
    }
  | { ok: false; error: string };

/**
 * Begin buying extra locations.
 *
 * ★ Gated on `ai`, not `locations`: this spends money, so it is the billing gate
 * rather than the one that merely manages shops.
 */
export async function startBuyLocations(
  requested: unknown,
): Promise<LocationPurchaseResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (typeof requested !== "number" || !Number.isInteger(requested)) {
    return { ok: false, error: "Choose a whole number of extra locations." };
  }

  const [storeId, store, locationPrice] = await Promise.all([
    getActingStoreId(),
    getCurrentStore(),
    // LIVE — this number becomes a charge, so never the cached reader.
    getExtraLocationPricingLive(),
  ]);
  const started = await startLocationPurchase({
    storeId,
    store,
    requested,
    locationPrice,
  });
  if (!started.ok) return { ok: false, error: started.error };
  return { ok: true, ...started.data };
}

export type LocationConfirmResult =
  | { ok: true; billedLocations: number }
  | { ok: false; error: string };

export async function confirmBuyLocations(
  invoiceId: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<LocationConfirmResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }

  const storeId = await getActingStoreId();
  const done = await confirmLocationPurchase({
    storeId,
    invoiceId,
    providerPaymentId,
    signature,
  });
  if (!done.ok) return { ok: false, error: done.error };

  // The allowance is a plan gate, so every reader must see the new number.
  revalidateTag(STORE_TAG, "max");
  return { ok: true, billedLocations: done.data.billedLocations };
}

export type ReleaseLocationsResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Book a reduction for the end of the current cycle.
 *
 * ★ No money moves, in either direction — they keep what they paid for until it
 * runs out, and nobody is refunded (§15b).
 */
export async function releaseExtraLocations(
  requested: unknown,
): Promise<ReleaseLocationsResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (typeof requested !== "number" || !Number.isInteger(requested)) {
    return { ok: false, error: "Choose a whole number of extra locations." };
  }

  const [storeId, store] = await Promise.all([
    getActingStoreId(),
    getCurrentStore(),
  ]);
  const done = await releaseLocations({ storeId, store, requested });
  if (!done.ok) return { ok: false, error: done.error };

  const when = done.data.effectiveAt
    ? new Date(done.data.effectiveAt).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : null;
  return {
    ok: true,
    message: when
      ? `Booked. You keep the location until ${when}, then stop paying for it.`
      : "Booked. You keep the location until this cycle ends.",
  };
}

// ---------------------------------------------------------------------------
// Cancelling, resuming, and changing plan.
//
// ★ None of these calls the gateway to change a schedule — StoreMink owns the
// amount and the dates, so cancelling is a flag and a downgrade is a booked
// change. Only a DEARER change moves money, and it does so through the same
// one-off checkout as enrolment and location purchases.
// ---------------------------------------------------------------------------

/** The subscription card's data. Read-only, so gated on VIEW. */
export async function getMySubscription(): Promise<SubscriptionView> {
  const userId = await getManagerUserId("ai");
  const storeId = await getActingStoreId();
  // No permission still returns the neutral view rather than throwing — the page
  // renders other things, and `active: false` simply hides the controls.
  if (!userId) {
    return {
      plan: null,
      period: null,
      status: null,
      currentEnd: null,
      cancelAtPeriodEnd: false,
      scheduledPlan: null,
      scheduledPeriod: null,
      scheduledLocations: null,
      autopay: false,
      active: false,
    };
  }
  return getSubscriptionView(storeId);
}

export type CancelActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function cancelMySubscription(): Promise<CancelActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  const done = await cancelAtPeriodEnd({ storeId });
  if (!done.ok) return { ok: false, error: done.error };

  const until = done.data.accessUntil
    ? new Date(done.data.accessUntil).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : null;
  return {
    ok: true,
    // ★ The promise has to match what will happen. Access runs to the end of the
    // cycle only if there IS one — between authorising and the first charge there
    // isn't, and promising a plan they were never charged for sets up the wrong
    // expectation.
    message: until
      ? `Cancelled. You keep your plan until ${until}, then move to Free.`
      : "Cancelled. No further payments will be taken.",
  };
}

export async function resumeMySubscription(): Promise<CancelActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  const done = await resumeSubscription({ storeId });
  if (!done.ok) return { ok: false, error: done.error };
  return {
    ok: true,
    // ⚠ Autopay is NOT restored — the mandate was withdrawn on cancel and only
    // the merchant can authorise a new one. Saying otherwise has them expect a
    // charge that never comes, and be downgraded for it.
    message: done.data.autopay
      ? "Resumed. Your plan will renew as normal."
      : "Resumed. Autopay is off, so we'll ask you to pay each renewal.",
  };
}

export type PlanChangeActionResult =
  | {
      ok: true;
      /** Present when a payment is needed to apply it now. */
      payment?: {
        invoiceId: string;
        providerOrderId: string;
        keyId: string;
        amountPaise: number;
      };
      scheduled: boolean;
      message: string;
    }
  | { ok: false; error: string };

/**
 * Move to a different plan or billing period.
 *
 * ★ The DIRECTION decides the timing, and the server decides the direction —
 * there is no "apply now" option to pick, because on a downgrade that means a
 * refund (§15b).
 */
export async function changeMyPlan(
  plan: unknown,
  period: unknown,
): Promise<PlanChangeActionResult> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "Choose a paid plan." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";

  const [storeId, locationPrice] = await Promise.all([
    getActingStoreId(),
    getExtraLocationPricingLive(),
  ]);
  const started = await startPlanChange({
    storeId,
    targetPlan: plan,
    targetPeriod: billingPeriod,
    priceFor,
    locationPrice,
  });
  if (!started.ok) return { ok: false, error: started.error };

  const name = PLAN_META[plan].name;
  if (started.data.payment) {
    return {
      ok: true,
      payment: started.data.payment,
      scheduled: false,
      message: `Moving to ${name}.`,
    };
  }
  // Applied free (a part period that rounded to nothing) or booked for later.
  if (started.data.scheduled) {
    const when = started.data.effectiveAt
      ? new Date(started.data.effectiveAt).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "Asia/Kolkata",
        })
      : null;
    return {
      ok: true,
      scheduled: true,
      message: when
        ? `Booked. You keep your current plan until ${when}, then move to ${name} billed ${billingPeriod}.`
        : `Booked. You'll move to ${name} at the end of this cycle.`,
    };
  }
  revalidateTag(STORE_TAG, "max");
  return { ok: true, scheduled: false, message: `You're on ${name}.` };
}

export async function confirmMyPlanChange(
  invoiceId: unknown,
  plan: unknown,
  period: unknown,
  providerPaymentId: unknown,
  signature: unknown,
): Promise<{ ok: true; plan: Plan } | { ok: false; error: string }> {
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };
  if (
    typeof invoiceId !== "string" ||
    typeof providerPaymentId !== "string" ||
    typeof signature !== "string" ||
    !invoiceId ||
    !providerPaymentId ||
    !signature
  ) {
    return { ok: false, error: "That payment couldn't be confirmed." };
  }
  // ★ RE-VALIDATED, not trusted: the plan and period come from the client, and
  // the invoice carries only the location count.
  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "That plan isn't valid." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";

  const storeId = await getActingStoreId();
  const done = await confirmPlanChange({
    storeId,
    invoiceId,
    targetPlan: plan,
    targetPeriod: billingPeriod,
    providerPaymentId,
    signature,
  });
  if (!done.ok) return { ok: false, error: done.error };

  revalidateTag(STORE_TAG, "max");
  return { ok: true, plan: done.data.plan };
}
