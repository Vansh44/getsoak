import "server-only";

/**
 * Moving between plans and billing periods, on the new billing system (§34).
 *
 * ★★ THE DIRECTION DECIDES THE TIMING, NOT THE MERCHANT. Dearer applies NOW and
 * is paid for now; cheaper or equal waits for the end of the cycle they already
 * paid for. That is the §15b rule and its point is that **nobody is ever
 * refunded** — which keeps refunds, partial reversals and their disputes out of
 * the system. "Apply now" on a downgrade is the option that looks generous and
 * creates a refund.
 *
 * ★ IT COMPARES AMOUNTS, NOT TIERS. Rank would read monthly→yearly as "no
 * change" while the charge is ten times bigger, and would miss that a tier
 * downgrade can still be a price INCREASE for a merchant grandfathered on an
 * older price. `decidePlanChange` does that comparison and is shared with the old
 * path's tests, so the rule is proved once.
 *
 * ★ PERIOD CHANGES ARE FIRST-CLASS. They were impossible on the old path for a
 * mechanical reason — `scheduled_plan` cannot express "same tier, different
 * period" — and the schema carries `scheduled_period` precisely so it can.
 *
 * ★★ AND THE PRORATION USES THE SAME MACHINERY AS A LOCATION PURCHASE: an `addon`
 * invoice paid on session. One payment shape for every mid-cycle charge means one
 * place where money can go wrong, not three.
 */

import { and, desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingInvoices,
  billingPaymentAttempts,
  billingSubscriptions,
  stores,
} from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  verifyCapturedCheckoutPayment,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import {
  billingMayApplyPlan,
  decidePlanChange,
} from "@/lib/payments/plan-change";
import { PLAN_META, limitsFor, normalizePlan, type Plan } from "@/lib/plans";
import {
  subscriptionTotalPaise,
  type BillingPeriod,
  type LocationPrice,
} from "@/lib/plans/location-billing";
import { PERIOD_DAYS } from "./cycle";
import { buildAddonInvoice, prorationPaise } from "./invoice";
import {
  amountDueForInvoice,
  createAddonInvoice,
  finalizeInvoice,
  loadInvoiceParties,
  loadTaxContext,
} from "./invoice-store";
import { beginAttempt, settleAttempt } from "./collect";

export type PlanChangeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const LIVE_STATES = ["active", "past_due", "grace"];

export interface PlanChangeStart {
  /** Present when a payment is needed. Absent when the change was scheduled. */
  payment?: {
    invoiceId: string;
    providerOrderId: string;
    keyId: string;
    amountPaise: number;
  };
  /** True when it took effect (or will) without a payment. */
  scheduled: boolean;
  /** When a scheduled change lands. */
  effectiveAt: string | null;
  plan: Plan;
  period: BillingPeriod;
}

interface SubRow {
  plan: string;
  period: string;
  state: string;
  billedLocations: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  mandateId: string | null;
}

async function loadSub(storeId: string): Promise<SubRow | null | undefined> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          state: billingSubscriptions.state,
          billedLocations: billingSubscriptions.billedLocations,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.plan_change.load", err, { storeId });
    return undefined;
  }
}

/**
 * Begin a plan or period change.
 *
 * Returns either a payment to open (dearer) or a booked change (cheaper/equal).
 */
export async function startPlanChange(input: {
  storeId: string;
  targetPlan: Plan;
  targetPeriod: BillingPeriod;
  /** LIVE prices — these decide a charge. */
  priceFor: (
    plan: Plan,
    period: BillingPeriod,
  ) => Promise<{ planPaise: number }>;
  locationPrice: LocationPrice;
  now?: Date;
}): Promise<PlanChangeResult<PlanChangeStart>> {
  const now = input.now ?? new Date();

  const sub = await loadSub(input.storeId);
  // Fails closed: unable to read means unable to rule out charging wrongly.
  if (sub === undefined) {
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  if (!sub || !LIVE_STATES.includes(sub.state) || !sub.currentPeriodEnd) {
    return {
      ok: false,
      error: "You don't have an active subscription to change.",
    };
  }
  // ★ A cancelling subscription has no next cycle to schedule into, and applying
  // a change now would contradict the cancellation. Resume first.
  if (sub.cancelAtPeriodEnd) {
    return {
      ok: false,
      error:
        "Your subscription is cancelling. Resume it first, then change your plan.",
    };
  }
  if (input.targetPlan === "free") {
    return {
      ok: false,
      error: "Cancel your subscription to move to the Free plan.",
    };
  }

  const currentPlan = normalizePlan(sub.plan);
  const currentPeriod: BillingPeriod =
    sub.period === "yearly" ? "yearly" : "monthly";

  // ★ Locations are dropped when the TARGET plan has no POS — charging for shops
  // a plan cannot use is indefensible, and `resolveNextCycle` applies the same
  // rule when the change lands, so the quote and the outcome agree.
  const targetLocations =
    limitsFor(input.targetPlan).posLocationsIncluded > 0
      ? sub.billedLocations
      : 0;

  const [currentPrice, targetPrice] = await Promise.all([
    input.priceFor(currentPlan, currentPeriod),
    input.priceFor(input.targetPlan, input.targetPeriod),
  ]);

  const currentAmountPaise = subscriptionTotalPaise(
    currentPrice.planPaise,
    sub.billedLocations,
    currentPeriod,
    input.locationPrice,
  );
  const targetAmountPaise = subscriptionTotalPaise(
    targetPrice.planPaise,
    targetLocations,
    input.targetPeriod,
    input.locationPrice,
  );

  const decision = decidePlanChange({
    currentPlan,
    currentPeriod,
    targetPlan: input.targetPlan,
    targetPeriod: input.targetPeriod,
    currentAmountPaise,
    targetAmountPaise,
  });
  if (decision.kind === "noop") {
    return { ok: false, error: decision.reason };
  }

  // ── Cheaper or equal: book it for the cycle end, move no money ────────────
  if (!decision.immediate) {
    // ★ REFUSED INSIDE THE COLLECTION WINDOW, for the same reason a location
    // release is: the next cycle's invoice is already issued and immutable, so
    // applying the change at the turn would bill the OLD plan for a cycle spent
    // on the new one. Refusing for a few days beats a silent mispricing.
    if (await nextInvoiceIssued(input.storeId, sub.currentPeriodEnd)) {
      return {
        ok: false,
        error: `Your next invoice has already been issued. You can change plans again after ${fmtDate(sub.currentPeriodEnd)}.`,
      };
    }
    const booked = await schedule(input.storeId, {
      plan: input.targetPlan,
      period: input.targetPeriod,
      now,
    });
    if (!booked) {
      return { ok: false, error: "Couldn't schedule that change. Try again." };
    }
    return {
      ok: true,
      data: {
        scheduled: true,
        effectiveAt: sub.currentPeriodEnd,
        plan: input.targetPlan,
        period: input.targetPeriod,
      },
    };
  }

  // ── Dearer: charge the difference for the rest of this cycle, now ─────────
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { ok: false, error: "Payments aren't available now." };

  const amountPaise = prorationPaise({
    currentPeriodPaise: currentAmountPaise,
    targetPeriodPaise: targetAmountPaise,
    period: currentPeriod,
    periodEnd: new Date(sub.currentPeriodEnd),
    now,
    periodDays: PERIOD_DAYS[currentPeriod],
  });

  // ★ At the very end of a cycle the part period rounds to nothing, and Razorpay
  // refuses a ₹0 order. Apply it free rather than refusing the upgrade: the
  // merchant gains a few hours and the next invoice bills the new plan in full.
  if (amountPaise <= 0) {
    const applied = await applyNow(input.storeId, {
      plan: input.targetPlan,
      period: input.targetPeriod,
      locations: targetLocations,
      now,
    });
    if (!applied) {
      return { ok: false, error: "Couldn't change your plan. Try again." };
    }
    return {
      ok: true,
      data: {
        scheduled: false,
        effectiveAt: null,
        plan: input.targetPlan,
        period: input.targetPeriod,
      },
    };
  }

  const tax = await loadTaxContext(input.storeId);
  const built = buildAddonInvoice({
    description: `${PLAN_META[input.targetPlan].name} plan · part period to ${fmtDate(sub.currentPeriodEnd)}`,
    amountPaise,
    tax,
  });

  // Not finalized — an unpaid upgrade must not burn a GST number (the enrolment
  // rule). `confirmPlanChange` issues it once the payment verifies.
  const parties = await loadInvoiceParties(input.storeId);
  const invoice = await createAddonInvoice({
    ...parties,
    storeId: input.storeId,
    built,
    // ★ Reuses the addon target field to carry the LOCATION count that applies
    // after the change, so confirm writes what was priced. The plan and period
    // themselves are re-derived from the request and re-validated there.
    targetCount: targetLocations,
  });
  if (!invoice) return { ok: false, error: "Couldn't prepare your invoice." };

  const due = await amountDueForInvoice(invoice.id);
  if (due === null || due <= 0) {
    return { ok: false, error: "Couldn't work out what's due." };
  }

  const attempt = await beginAttempt({
    invoiceId: invoice.id,
    storeId: input.storeId,
    amountPaise: due,
    mode: "manual",
  });
  if (!attempt) {
    return {
      ok: false,
      error: "A payment is already in progress. Give it a moment.",
    };
  }

  const order = await rzpCreateOrder(creds, {
    amountPaise: due,
    receipt: invoice.id.slice(0, 30),
    notes: {
      store_id: input.storeId,
      invoice_id: invoice.id,
      sm_billing_key: attempt.idempotencyKey,
      plan: input.targetPlan,
      period: input.targetPeriod,
    },
  });
  if (!order.ok) {
    await settleAttempt(
      attempt.attemptId,
      order.outcome === "unknown" ? "unknown" : "failed",
      { failureCode: "order_create", failureReason: order.error, now },
    );
    return { ok: false, error: "Couldn't start the payment. Try again." };
  }

  await settleAttempt(attempt.attemptId, "processing", {
    providerOrderId: order.data.id,
    now,
  });

  return {
    ok: true,
    data: {
      payment: {
        invoiceId: invoice.id,
        providerOrderId: order.data.id,
        keyId: creds.keyId,
        amountPaise: due,
      },
      scheduled: false,
      effectiveAt: null,
      plan: input.targetPlan,
      period: input.targetPeriod,
    },
  };
}

/**
 * Settle an immediate (dearer) plan change and apply it.
 *
 * ★ THE TARGET IS RE-VALIDATED HERE, not trusted. The plan and period arrive from
 * the client, so this re-checks them against `PLAN_IDS` and re-runs the comp floor
 * — the invoice only carries the location count.
 */
export async function confirmPlanChange(input: {
  storeId: string;
  invoiceId: string;
  targetPlan: Plan;
  targetPeriod: BillingPeriod;
  providerPaymentId: string;
  signature: string;
  now?: Date;
}): Promise<PlanChangeResult<{ plan: Plan; period: BillingPeriod }>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { ok: false, error: "Payments aren't available now." };

  let found: {
    attemptId: string;
    providerOrderId: string | null;
    amountPaise: number;
    locations: number;
  } | null = null;
  try {
    found = await withService(async (db) => {
      const [inv] = await db
        .select({ locations: billingInvoices.addonTargetCount })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, input.invoiceId),
            // Scoped by store: an invoice id alone must never let one merchant
            // settle another's payment or benefit from it.
            eq(billingInvoices.storeId, input.storeId),
            eq(billingInvoices.kind, "addon"),
          ),
        )
        .limit(1);
      if (!inv || inv.locations === null) return null;
      const [att] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            eq(billingPaymentAttempts.storeId, input.storeId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      if (!att) return null;
      return {
        attemptId: att.id,
        providerOrderId: att.providerOrderId,
        amountPaise: att.amountPaise,
        locations: inv.locations,
      };
    });
  } catch (err) {
    logError("billing.plan_change.confirm_load", err, {
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "Couldn't confirm that payment." };
  }

  if (!found?.providerOrderId) {
    return { ok: false, error: "No payment to confirm." };
  }

  if (
    !verifyCheckoutSignature(
      creds.keySecret,
      found.providerOrderId,
      input.providerPaymentId,
      input.signature,
    )
  ) {
    logError(
      "billing.plan_change.bad_signature",
      new Error("signature mismatch"),
      { storeId: input.storeId, invoiceId: input.invoiceId },
    );
    return { ok: false, error: "We couldn't verify that payment." };
  }

  const observedPayment = await verifyCapturedCheckoutPayment(creds, {
    paymentId: input.providerPaymentId,
    orderId: found.providerOrderId,
    amountPaise: found.amountPaise,
  });
  if (!observedPayment.ok) {
    logError(
      "billing.plan_change.gateway_mismatch",
      new Error(observedPayment.error),
      { storeId: input.storeId, invoiceId: input.invoiceId },
    );
    return { ok: false, error: observedPayment.error };
  }

  // ★★ FINALIZE BEFORE SETTLING. THE ORDER IS LOAD-BEARING, AND GETTING IT
  // WRONG BILLS A MERCHANT FOR MONEY THEY HAVE ALREADY PAID.
  //
  // `settleAttempt` → `syncInvoiceStatus` claims the move to paid with
  // `inArray(status, ["open", "processing"])`. A draft invoice is in NEITHER
  // list, so settling first claims ZERO rows: the attempt goes `captured`, the
  // invoice stays unpaid, `paid_at` stays null and NO receipt is sent — all
  // silently, because a zero-row claim is indistinguishable from "already done".
  // `finalizeInvoice` then sets `status: "open"`, producing an OPEN invoice
  // standing behind a CAPTURED payment: phantom debt that dunning chases and the
  // downgrade clock runs against.
  //
  // MEASURED ON PRODUCTION (2026-09-06). Store `echos` paid for a plan change on
  // 2026-08-16 16:50:11Z (attempt captured, pay_TQVs5DiqE6giOW). The invoice's
  // `paid_at` was 2026-09-05 21:15:41Z — a lag of **20 days 4 hours** — because
  // it was only claimed when the merchant clicked "Pay now" on a bill they did
  // not owe, and `syncInvoiceStatus` recomputed over the old captured attempt.
  // That click also fired the receipt, so they received "Payment received" for a
  // payment they had just CANCELLED. Had they completed it, they would have paid
  // twice.
  //
  // ⚠ Finalizing first does NOT weaken "a number is spent only on an invoice
  // that was really paid" (§34): both the checkout signature and
  // `verifyCapturedCheckoutPayment` have already passed above, so the money is
  // confirmed captured at the gateway before this line runs.
  await finalizeInvoice(input.invoiceId, now);

  const settled = await settleAttempt(found.attemptId, "captured", {
    providerPaymentId: input.providerPaymentId,
    now,
  });
  if (settled && settled !== "captured") {
    return { ok: false, error: "That payment didn't complete." };
  }

  const applied = await applyNow(input.storeId, {
    plan: input.targetPlan,
    period: input.targetPeriod,
    locations: found.locations,
    now,
  });
  if (!applied) {
    // ★ The money is IN. Never a bare failure (the §15 rule).
    return {
      ok: false,
      error:
        "Your payment went through but we couldn't switch your plan. Contact support — don't pay again.",
    };
  }
  return {
    ok: true,
    data: { plan: input.targetPlan, period: input.targetPeriod },
  };
}

/** Book a change for the end of the current cycle. */
async function schedule(
  storeId: string,
  input: { plan: Plan; period: BillingPeriod; now: Date },
): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .update(billingSubscriptions)
        .set({
          scheduledPlan: input.plan,
          scheduledPeriod: input.period,
          updatedAt: input.now.toISOString(),
        })
        .where(eq(billingSubscriptions.storeId, storeId));
    });
    return true;
  } catch (err) {
    logError("billing.plan_change.schedule", err, { storeId });
    return false;
  }
}

/**
 * Apply a change immediately, in BOTH places.
 *
 * ★★ THE COMP FLOOR HOLDS. `stores.plan` is the entitlement every gate reads, and
 * an operator comp must never be overwritten DOWNWARD by billing — the defect
 * that cost a real merchant their Pro plan (§15). Only `billing_subscriptions`
 * moves when the floor refuses; the merchant keeps the better plan they were
 * given and has paid for a change that leaves them no worse off.
 *
 * ★ THE CYCLE IS NOT RESTARTED. They paid a part period to the existing boundary,
 * so moving the boundary would either give away time or take it.
 */
async function applyNow(
  storeId: string,
  input: {
    plan: Plan;
    period: BillingPeriod;
    locations: number;
    now: Date;
  },
): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .update(billingSubscriptions)
        .set({
          plan: input.plan,
          period: input.period,
          billedLocations: input.locations,
          // Superseded — they just changed plan directly.
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          updatedAt: input.now.toISOString(),
        })
        .where(eq(billingSubscriptions.storeId, storeId));

      const [store] = await db
        .select({ plan: stores.plan, planSource: stores.planSource })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);

      if (
        store &&
        billingMayApplyPlan(store.plan, store.planSource, input.plan)
      ) {
        await db
          .update(stores)
          .set({ plan: input.plan, planSource: "paid" })
          .where(eq(stores.id, storeId));
      }
    });
    return true;
  } catch (err) {
    logError("billing.plan_change.apply", err, { storeId });
    return false;
  }
}

/** Has the invoice for the cycle AFTER `periodEnd` already been raised? */
async function nextInvoiceIssued(
  storeId: string,
  periodEnd: string,
): Promise<boolean> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ id: billingInvoices.id })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            eq(billingInvoices.kind, "subscription"),
            eq(billingInvoices.periodStart, periodEnd),
          ),
        )
        .limit(1);
      return !!row;
    });
  } catch (err) {
    logError("billing.plan_change.next_invoice", err, { storeId });
    // Fails toward refusing: booking a change we cannot price correctly is the
    // outcome that silently mischarges.
    return true;
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}
