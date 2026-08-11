import "server-only";

/**
 * Enrolment — a merchant's first paid cycle, and the mandate for later ones.
 *
 * Design: docs/billing-architecture.md §7.
 *
 * ★★ THIS WORKS WITHOUT THE UNVERIFIED RECURRING ENDPOINT, and that is the
 * point. The first cycle is collected ON SESSION, with the merchant watching, by
 * the same one-time Razorpay checkout the AI-credit purchase already uses
 * (`rzpCreateOrder` + `verifyCheckoutSignature` — both verified and live). Only
 * the SUBSEQUENT charge needs the endpoint that is still unconfirmed, so a
 * merchant can subscribe and pay today; what they cannot yet get is automatic
 * renewal, which falls back to manual payment.
 *
 * ★★ THE PLAN IS NOT GRANTED UNTIL THE PAYMENT IS CAPTURED. There is no grace on
 * the first cycle — grace exists for RENEWALS, where the merchant has already
 * paid for something. Granting it up front would hand anyone 48 hours of Pro for
 * starting a checkout they never finish.
 *
 * ⚠ TWO PLACES RECORD THE PLAN, and both must move. `stores.plan` is the
 * ENTITLEMENT — `effectivePlan` and every gate in the product read it —
 * while `billing_subscriptions` is this system's own state. Writing one without
 * the other gives a merchant either a bill with no features or features with no
 * bill.
 */

import { and, desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingAccounts,
  billingMandates,
  billingPaymentAttempts,
  billingSubscriptions,
  planEvents,
  stores,
} from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import { billingMayApplyPlan } from "@/lib/payments/plan-change";
import { PLAN_META, limitsFor, type Plan } from "@/lib/plans";
import { cycleFrom, mandateSizePaise } from "./cycle";
import { buildSubscriptionInvoice } from "./invoice";
import {
  amountDueForInvoice,
  ensureRenewalInvoice,
  finalizeInvoice,
  loadTaxContext,
} from "./invoice-store";
import { beginAttempt, settleAttempt } from "./collect";

type BillingPeriod = "monthly" | "yearly";

/** The first cycle a subscription ever has. */
const FIRST_CYCLE = 1;

/** States in which the store is already ON a paid cycle we are billing for. */
const LIVE_STATES = ["active", "past_due", "grace"] as const;

export interface EnrolmentStart {
  invoiceId: string;
  attemptId: string;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  /** What the merchant will be asked to authorise for future cycles. */
  suggestedMandateMaxPaise: number;
}

export type EnrolmentResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Create or update the party the invoice is addressed to.
 *
 * Idempotent per store, and separate from the subscription because it outlives
 * one: a merchant who cancels and re-subscribes keeps their billing identity.
 */
export async function ensureBillingAccount(
  storeId: string,
  details: {
    billingEmail?: string | null;
    legalName?: string | null;
    gstin?: string | null;
    /** NUMERIC GST state code ("07", "29") — the DB CHECK refuses anything else. */
    stateCode?: string | null;
    address?: Record<string, unknown>;
  } = {},
): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .insert(billingAccounts)
        .values({
          storeId,
          billingEmail: details.billingEmail ?? null,
          legalName: details.legalName ?? null,
          gstin: details.gstin ?? null,
          stateCode: details.stateCode ?? null,
          address: details.address ?? {},
        })
        .onConflictDoUpdate({
          target: billingAccounts.storeId,
          set: {
            // Only overwrite what was actually supplied — a partial edit must
            // not blank a field the caller did not mention.
            ...(details.billingEmail !== undefined
              ? { billingEmail: details.billingEmail }
              : {}),
            ...(details.legalName !== undefined
              ? { legalName: details.legalName }
              : {}),
            ...(details.gstin !== undefined ? { gstin: details.gstin } : {}),
            ...(details.stateCode !== undefined
              ? { stateCode: details.stateCode }
              : {}),
            ...(details.address !== undefined
              ? { address: details.address }
              : {}),
            updatedAt: new Date().toISOString(),
          },
        });
    });
    return true;
  } catch (err) {
    logError("billing.ensure_account", err, { storeId });
    return false;
  }
}

/**
 * Begin enrolment: issue the first invoice and open a payment for it.
 *
 * Returns what the client needs to open Razorpay Checkout. Nothing about the
 * merchant's plan changes here — see `confirmEnrolment`.
 */
export async function startEnrolment(input: {
  storeId: string;
  plan: Plan;
  period: BillingPeriod;
  priceFor: (
    plan: Plan,
    period: BillingPeriod,
  ) => Promise<{ planPaise: number; locationPaise: number }>;
  now?: Date;
}): Promise<EnrolmentResult<EnrolmentStart>> {
  const now = input.now ?? new Date();

  if (input.plan === "free") {
    return { ok: false, error: "The free plan needs no subscription." };
  }
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { ok: false, error: "Subscriptions aren't available right now." };
  }

  // ★★ REFUSE IF THIS STORE IS ALREADY ON A PAID CYCLE. Without this,
  // `seedSubscription`'s upsert rewrites `plan`/`period` on a LIVE subscription
  // before anything is paid — a merchant on Basic could point their record at
  // Pro and dismiss the payment window. The flow would then fail confusingly
  // ("already paid for") because cycle 1's invoice is long settled, leaving the
  // record changed and the money not taken. Changing tier mid-cycle is a
  // PRORATED plan change, a different operation from enrolling.
  const existing = await currentState(input.storeId);
  if (existing === null) {
    // Fails closed: unable to read means unable to rule out double-billing.
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  if (LIVE_STATES.includes(existing as (typeof LIVE_STATES)[number])) {
    return {
      ok: false,
      error: "This store already has a subscription.",
    };
  }

  const price = await input.priceFor(input.plan, input.period);
  const tax = await loadTaxContext(input.storeId);
  const cycle = cycleFrom(now, input.period, FIRST_CYCLE);

  // ★ No locations on a first cycle. Extra shops are bought AFTER a plan is
  // live, so billing for them here would charge for something nobody has.
  const built = buildSubscriptionInvoice({
    planLabel: PLAN_META[input.plan].name,
    period: input.period,
    planPaise: price.planPaise,
    tax,
  });

  // ★ Ensure the subscription row FIRST, in a non-entitling state. It is what
  // makes enrolment resumable: a merchant who closes the tab and comes back
  // finds the same cycle_seq, so `ensureRenewalInvoice` returns the same invoice
  // instead of issuing a second one.
  const seeded = await seedSubscription({
    storeId: input.storeId,
    plan: input.plan,
    period: input.period,
    cycle,
  });
  if (!seeded) return { ok: false, error: "Couldn't start the subscription." };

  const invoice = await ensureRenewalInvoice({
    storeId: input.storeId,
    cycleSeq: FIRST_CYCLE,
    periodStart: cycle.start,
    periodEnd: cycle.end,
    dueAt: now,
    built,
  });
  if (!invoice) return { ok: false, error: "Couldn't prepare your invoice." };

  if (invoice.status === "paid") {
    return { ok: false, error: "This subscription is already paid for." };
  }
  if (!invoice.finalizedAt) {
    const issued = await finalizeInvoice(invoice.id, now);
    if (!issued) return { ok: false, error: "Couldn't issue your invoice." };
  }

  const amountDue = await amountDueForInvoice(invoice.id);
  if (amountDue === null || amountDue <= 0) {
    return { ok: false, error: "Couldn't work out what's due." };
  }

  const attempt = await beginAttempt({
    invoiceId: invoice.id,
    storeId: input.storeId,
    amountPaise: amountDue,
    mode: "manual",
  });
  // ★ Refused because one is already in flight — three clicks on Subscribe, or
  // a reopened tab. Telling them to wait is right; opening a second charge is not.
  if (!attempt) {
    return {
      ok: false,
      error: "A payment is already in progress. Give it a moment.",
    };
  }

  const order = await rzpCreateOrder(creds, {
    amountPaise: amountDue,
    receipt: invoice.invoiceRef ?? invoice.id.slice(0, 30),
    notes: {
      store_id: input.storeId,
      invoice_id: invoice.id,
      // The idempotency key travels with the payment, so reconciliation can
      // match it even if we never see the response.
      sm_billing_key: attempt.idempotencyKey,
    },
  });
  if (!order.ok) {
    // A rejected order means nothing was created at the gateway, so the attempt
    // is genuinely dead. An UNKNOWN is left in flight for reconciliation.
    await settleAttempt(
      attempt.attemptId,
      order.outcome === "unknown" ? "unknown" : "failed",
      { failureCode: "order_create", failureReason: order.error, now },
    );
    return {
      ok: false,
      error: "Couldn't start the payment. Please try again.",
    };
  }

  await settleAttempt(attempt.attemptId, "processing", {
    providerOrderId: order.data.id,
    now,
  });

  return {
    ok: true,
    data: {
      invoiceId: invoice.id,
      attemptId: attempt.attemptId,
      providerOrderId: order.data.id,
      keyId: creds.keyId,
      amountPaise: amountDue,
      suggestedMandateMaxPaise: mandateSizePaise({
        planPaise: price.planPaise,
        taxInclusive: tax.inclusive,
      }),
    },
  };
}

/**
 * This store's subscription state, or "" when it has none.
 *
 * Returns NULL on a read failure — distinct from "no subscription", because the
 * caller must fail closed rather than treat a database blip as a free pass.
 */
async function currentState(storeId: string): Promise<string | null> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ state: billingSubscriptions.state })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      return row?.state ?? "";
    });
  } catch (err) {
    logError("billing.current_state", err, { storeId });
    return null;
  }
}

/** Create the subscription row in a state that grants NOTHING. */
async function seedSubscription(input: {
  storeId: string;
  plan: Plan;
  period: BillingPeriod;
  cycle: { start: Date; end: Date; seq: number };
}): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .insert(billingSubscriptions)
        .values({
          storeId: input.storeId,
          plan: input.plan,
          period: input.period,
          // ★ `free` until the money lands. The cycle columns stay NULL, which
          // the billing_subscriptions_cycle_present CHECK requires for any
          // non-paid state — and which keeps the renewal worker away from a
          // subscription nobody has paid for.
          state: "free",
          currentCycleSeq: 0,
          planSource: "paid",
        })
        .onConflictDoUpdate({
          target: billingSubscriptions.storeId,
          set: {
            plan: input.plan,
            period: input.period,
            updatedAt: new Date().toISOString(),
          },
        });
    });
    return true;
  } catch (err) {
    logError("billing.seed_subscription", err, { storeId: input.storeId });
    return false;
  }
}

export interface ConfirmedEnrolment {
  plan: Plan;
  periodEnd: string;
  mandateActivated: boolean;
}

/**
 * Complete enrolment after the merchant's payment.
 *
 * ★ THE SIGNATURE IS THE TRUST BOUNDARY. The client hands us a payment id and a
 * signature; only the HMAC proves the payment belongs to the order WE created.
 * Without that check anyone could post an arbitrary id and be granted a plan.
 *
 * ★ IDEMPOTENT. The attempt claim settles once, so a double-submitted callback
 * grants the plan once. Re-confirming an already-paid enrolment reports success
 * rather than an error — from the merchant's point of view it worked.
 */
export async function confirmEnrolment(input: {
  storeId: string;
  invoiceId: string;
  providerPaymentId: string;
  signature: string;
  /** Present when the checkout also registered a mandate for future cycles. */
  mandate?: {
    providerTokenId: string;
    providerCustomerId?: string | null;
    method: "card" | "upi" | "emandate" | "nach" | "unknown";
    maxAmountPaise?: number | null;
  };
  now?: Date;
}): Promise<EnrolmentResult<ConfirmedEnrolment>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { ok: false, error: "Subscriptions aren't available right now." };
  }

  let attempt: {
    id: string;
    state: string;
    providerOrderId: string | null;
  } | null = null;
  try {
    attempt = await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          state: billingPaymentAttempts.state,
          providerOrderId: billingPaymentAttempts.providerOrderId,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            // Scoped by store as well as invoice: an invoice id alone must
            // never let one merchant settle another's payment.
            eq(billingPaymentAttempts.storeId, input.storeId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.confirm_load_attempt", err, {
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "Couldn't confirm the payment." };
  }

  if (!attempt?.providerOrderId) {
    return { ok: false, error: "No payment to confirm." };
  }

  if (
    !verifyCheckoutSignature(
      creds.keySecret,
      attempt.providerOrderId,
      input.providerPaymentId,
      input.signature,
    )
  ) {
    logWarn("billing.confirm_bad_signature", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "We couldn't verify that payment." };
  }

  const settled = await settleAttempt(attempt.id, "captured", {
    providerPaymentId: input.providerPaymentId,
    now,
  });
  // null means a concurrent settle won, or the attempt was already terminal.
  // Either way the money is accounted for; carry on and make the plan match.
  if (settled && settled !== "captured") {
    return { ok: false, error: "That payment didn't complete." };
  }

  // Returns the id, so activateSubscription does not have to look up the row it
  // just created — one fewer query, and no reliance on the one-active-mandate
  // index being the thing that makes a re-read correct.
  const mandateId = input.mandate
    ? await activateMandate({ storeId: input.storeId, ...input.mandate, now })
    : null;

  const activated = await activateSubscription({
    storeId: input.storeId,
    now,
    mandateId,
  });
  if (!activated) {
    // ★ The money is IN. Never report a bare failure here — say what happened,
    // because the merchant has paid and support needs to know the plan is the
    // part that did not move (the §15 rule).
    return {
      ok: false,
      error:
        "Your payment went through but we couldn't switch your plan over. Contact support — don't pay again.",
    };
  }

  return {
    ok: true,
    data: { ...activated, mandateActivated: mandateId !== null },
  };
}

/**
 * Move the merchant onto the plan they paid for — in BOTH places.
 *
 * ★ `billingMayApplyPlan` is honoured, and this is not theoretical: the old
 * `confirmSubscription` wrote `stores.plan` unconditionally, so a store on an
 * operator comp could have it overwritten DOWNWARD by subscribing to a cheaper
 * tier. A comp is a floor.
 */
async function activateSubscription(input: {
  storeId: string;
  now: Date;
  mandateId: string | null;
}): Promise<{ plan: Plan; periodEnd: string } | null> {
  try {
    return await withService(async (db) => {
      const [sub] = await db
        .select({
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          state: billingSubscriptions.state,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, input.storeId))
        .limit(1);
      if (!sub) return null;

      const plan = sub.plan as Plan;
      const period: BillingPeriod =
        sub.period === "yearly" ? "yearly" : "monthly";

      // Already live — a re-confirmed callback. Report the existing cycle.
      if (sub.state === "active" && sub.currentPeriodEnd) {
        return { plan, periodEnd: sub.currentPeriodEnd };
      }

      const cycle = cycleFrom(input.now, period, FIRST_CYCLE);

      await db
        .update(billingSubscriptions)
        .set({
          state: "active",
          currentCycleSeq: FIRST_CYCLE,
          currentPeriodStart: cycle.start.toISOString(),
          currentPeriodEnd: cycle.end.toISOString(),
          planSource: "paid",
          mandateId: input.mandateId,
          graceStartedAt: null,
          graceEndsAt: null,
          downgradedAt: null,
          updatedAt: input.now.toISOString(),
        })
        .where(eq(billingSubscriptions.storeId, input.storeId));

      // ── The entitlement half ──
      const [store] = await db
        .select({ plan: stores.plan, planSource: stores.planSource })
        .from(stores)
        .where(eq(stores.id, input.storeId))
        .limit(1);
      if (!store) return null;

      if (!billingMayApplyPlan(store.plan, store.planSource, plan)) {
        // An operator gave them something at least as good. Leave it, and leave
        // the subscription active — they are paying, and the comp is the floor.
        logWarn("billing.enrol_comp_floor", {
          storeId: input.storeId,
          compPlan: store.plan,
          paidPlan: plan,
        });
        return { plan: store.plan as Plan, periodEnd: cycle.end.toISOString() };
      }

      await db
        .update(stores)
        .set({
          plan,
          planSource: "paid",
          planExpiresAt: cycle.end.toISOString(),
        })
        .where(eq(stores.id, input.storeId));

      return { plan, periodEnd: cycle.end.toISOString() };
    });
  } catch (err) {
    logError("billing.activate_subscription", err, { storeId: input.storeId });
    return null;
  }
}

/**
 * Record the mandate the checkout registered.
 *
 * ★ Its OWN transaction, and best-effort. A mandate is for FUTURE cycles, so
 * failing to record one must never fail an enrolment whose money has already
 * landed — the merchant is on the plan they paid for either way, and the worst
 * case is that next cycle needs a manual payment.
 */
async function activateMandate(input: {
  storeId: string;
  providerTokenId: string;
  providerCustomerId?: string | null;
  method: "card" | "upi" | "emandate" | "nach" | "unknown";
  maxAmountPaise?: number | null;
  now: Date;
}): Promise<string | null> {
  try {
    return await withService(async (db) => {
      // One ACTIVE mandate per store (partial unique index). Retire any previous
      // one first, or the insert below is refused.
      await db
        .update(billingMandates)
        .set({ status: "revoked", revokedAt: input.now.toISOString() })
        .where(
          and(
            eq(billingMandates.storeId, input.storeId),
            eq(billingMandates.status, "active"),
          ),
        );

      const rows = await db
        .insert(billingMandates)
        .values({
          storeId: input.storeId,
          providerTokenId: input.providerTokenId,
          providerCustomerId: input.providerCustomerId ?? null,
          method: input.method,
          status: "active",
          maxAmountPaise: input.maxAmountPaise ?? null,
          authenticatedAt: input.now.toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: billingMandates.id });
      return rows[0]?.id ?? null;
    });
  } catch (err) {
    logError("billing.activate_mandate", err, { storeId: input.storeId });
    return null;
  }
}

/**
 * Audit the plan change.
 *
 * ★★ `source: "billing"`, NEVER `"paid"`. `plan_events.source` is
 * CHECK-constrained to operator|billing|system while `stores.plan_source` allows
 * comp|paid|trial, and all three previous billing writers reached for the wrong
 * one — rejected by Postgres every time, and because the insert shared a
 * transaction with the plan update, the rejection ROLLED BACK the plan the
 * merchant had just been charged for. It surfaced as "payment succeeded but
 * activating the plan failed", and it hid for months because the symptom is an
 * empty audit log.
 *
 * ★ Its OWN transaction, so an audit failure can never undo an activation.
 */
export async function auditEnrolment(input: {
  storeId: string;
  fromPlan: string | null;
  toPlan: string;
  note: string;
}): Promise<void> {
  try {
    await withService((db) =>
      db.insert(planEvents).values({
        storeId: input.storeId,
        fromPlan: input.fromPlan,
        toPlan: input.toPlan,
        source: "billing",
        actor: "billing-enrolment",
        note: input.note,
      }),
    );
  } catch (err) {
    logError("billing.audit_enrolment", err, { storeId: input.storeId });
  }
}

/** Is this plan one a merchant can subscribe to? */
export function isSubscribablePlan(plan: unknown): plan is Plan {
  return (
    (plan === "basic" || plan === "pro") &&
    limitsFor(plan as Plan).posLocationsIncluded >= 0
  );
}
