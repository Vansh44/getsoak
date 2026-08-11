"use server";

/**
 * Subscribing to a plan, on the new billing system (§34).
 *
 * ⚠ EVERY EXPORT OF THIS FILE IS A PUBLICLY REACHABLE ENDPOINT. That is what
 * makes the gate on each one load-bearing rather than decorative: these take a
 * merchant's money and change what their store is entitled to.
 *
 * ★ RUNS ALONGSIDE the old `subscription-actions.ts`, which still drives
 * `/dashboard/plans`. Nothing here retires that path — the cutover is its own
 * step, and until it happens a store must not be enrolled in both.
 * `startSubscribe` refuses when the OLD system already has a live mandate for
 * the store, so the two cannot both be billing the same merchant.
 */

import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { getActingStoreId, getManagerUserId } from "@/app/dashboard/lib/access";
import { withService } from "@/lib/db/client";
import { storeSubscriptions, stores } from "@/drizzle/schema";
import { STORE_TAG } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";
import { hasLiveMandate } from "@/lib/payments/plan-change";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
} from "@/lib/plans/pricing";
import { PLAN_IDS, type Plan } from "@/lib/plans";
import {
  confirmInvoicePayment,
  listPayableInvoices,
  startInvoicePayment,
  type PaymentStart,
} from "@/lib/billing/manual-pay";
import {
  auditEnrolment,
  confirmEnrolment,
  ensureBillingAccount,
  startEnrolment,
  type EnrolmentStart,
} from "@/lib/billing/enrol";

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

/** Does the OLD system already bill this store? */
async function hasLegacySubscription(storeId: string): Promise<boolean> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          rzpSubscriptionId: storeSubscriptions.rzpSubscriptionId,
          status: storeSubscriptions.status,
        })
        .from(storeSubscriptions)
        .where(eq(storeSubscriptions.storeId, storeId))
        .limit(1);
      return !!row?.rzpSubscriptionId && hasLiveMandate(row.status);
    });
  } catch (err) {
    // ★ FAILS CLOSED. If we cannot tell whether the old system is billing them,
    // refusing costs one merchant a retry; enrolling them anyway could bill the
    // same store twice, from two systems, with no single place to stop it.
    logError("billing.legacy_check", err, { storeId });
    return true;
  }
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
): Promise<SubscribeStart> {
  // Same gate the existing subscribe flow uses, deliberately: this is a new
  // path to the same act, and tightening it here would silently revoke the
  // ability from a role that can subscribe today.
  const userId = await getManagerUserId("ai");
  if (!userId)
    return { ok: false, error: "You don't have permission to do this." };

  if (!isPaidPlan(plan) || !PLAN_IDS.includes(plan)) {
    return { ok: false, error: "Choose a paid plan." };
  }
  const billingPeriod: BillingPeriod =
    period === "yearly" ? "yearly" : "monthly";

  const storeId = await getActingStoreId();

  if (await hasLegacySubscription(storeId)) {
    return {
      ok: false,
      error:
        "This store already has a subscription. Cancel it before starting a new one.",
    };
  }

  // Best-effort: an invoice can be issued without a billing profile, and
  // blocking a sale on optional identity fields would be the wrong trade.
  await ensureBillingAccount(storeId);

  const started = await startEnrolment({
    storeId,
    plan,
    period: billingPeriod,
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
// ★ Today this is the ONLY way a renewal gets paid, because automatic
// collection is gated behind an unverified endpoint (lib/billing/gateway.ts).
// Not a fallback: spec §18 makes it a first-class path, and it stays one after
// the recurring charge lands, for amounts over the AFA limit and for merchants
// with no live mandate.
// ---------------------------------------------------------------------------

export type PayInvoiceStart =
  | ({ ok: true } & PaymentStart)
  | { ok: false; error: string };

export type PayInvoiceConfirm =
  | { ok: true; planRestored: boolean }
  | { ok: false; error: string };

/** What this store still owes, for a "pay now" surface. */
export async function getPayableInvoices() {
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
