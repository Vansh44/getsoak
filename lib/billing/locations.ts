import "server-only";

/**
 * Buying and releasing extra locations, on the new billing system (§34).
 *
 * ★★ WHY THIS EXISTS AT ALL. The old path called `rzpUpdateSubscription` to move
 * the merchant onto a Razorpay plan priced for the new location count — and that
 * call is documented as working only for card-authorised subscriptions: _"You can
 * only update a Subscription authorised using cards and not via UPI and
 * Emandate."_ So for most Indian merchants buying a location did not work at all,
 * and could not be made to. That is the whole reason for the rebuild.
 *
 * Here, StoreMink owns the price. `billing_subscriptions.billed_locations` is the
 * count; the renewal worker bills `plan + locations × price` every cycle. So
 * changing the count needs NO gateway call for future cycles — only the
 * part-period amount for the cycle already in progress is collected, and that is
 * an ordinary one-off payment on the SAME verified checkout as enrolment.
 *
 * ── The two directions are deliberately asymmetric ──
 *
 * BUYING applies NOW and is paid for now. RELEASING waits for the end of the
 * cycle the merchant has already paid for. That is the §15b rule, and its point
 * is that **nobody is ever refunded** — which keeps refunds, partial reversals
 * and the disputes that come with them out of the system entirely. It is not the
 * merchant's choice: "apply now" on a release is the option that looks generous
 * and creates a refund.
 *
 * ★ A RELEASE IS NOT WRITTEN IMMEDIATELY. `scheduled_locations` holds it until
 * the cycle turns. Writing `billed_locations` down at once would drop the
 * allowance while they are still paying for the shop, so a store sitting exactly
 * on its ceiling would be refused a location it owns and has paid for.
 */

import { and, count, desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingInvoices,
  billingMandates,
  billingPaymentAttempts,
  billingSubscriptions,
  storeLocations,
} from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import { effectivePlan, limitsFor, type Plan } from "@/lib/plans";
import {
  extraLocationPaise,
  locationAllowance,
  releasableLocations,
  requiredBilledLocations,
  subscriptionTotalPaise,
  validateBilledLocations,
  type BillingPeriod,
  type LocationPrice,
} from "@/lib/plans/location-billing";
import type { LocationBillingState } from "./invoice-types";
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

export type { LocationBillingState };

/** Only what `effectivePlan` reads — the caller passes its already-loaded store. */
export interface StorePlanFields {
  plan?: unknown;
  plan_expires_at?: string | Date | null;
}

export type LocationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** States in which a subscription can be changed at all. */
const LIVE_STATES = ["active", "past_due", "grace"];

interface SubRow {
  plan: string;
  period: string;
  state: string;
  billedLocations: number;
  scheduledLocations: number | null;
  currentCycleSeq: number;
  currentPeriodEnd: string | null;
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
          scheduledLocations: billingSubscriptions.scheduledLocations,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.locations.load_sub", err, { storeId });
    // undefined = we could not tell, which callers must treat as "refuse",
    // distinct from null = there is genuinely no subscription.
    return undefined;
  }
}

async function countLocations(storeId: string): Promise<number | null> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ n: count() })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId));
      return row?.n ?? 0;
    });
  } catch (err) {
    logError("billing.locations.count", err, { storeId });
    return null;
  }
}

/**
 * What the Locations page renders.
 *
 * Read-only, so it is gated by the caller on VIEW of the section the merchant is
 * looking at — not on billing permissions.
 */
export async function getLocationBillingState(input: {
  storeId: string;
  store: StorePlanFields;
  locationPrice: LocationPrice;
  now?: Date;
}): Promise<LocationBillingState | null> {
  const now = input.now ?? new Date();
  const [sub, existing] = await Promise.all([
    loadSub(input.storeId),
    countLocations(input.storeId),
  ]);
  if (sub === undefined || existing === null) return null;

  const plan = effectivePlan(input.store);
  const billed = sub?.billedLocations ?? 0;
  const period: BillingPeriod = sub?.period === "yearly" ? "yearly" : "monthly";

  // ★ Buying folds the cost into the subscription, so there has to BE one. A
  // comped Pro store has no cycle to prorate against — telling them plainly
  // beats a button that fails.
  let blockedReason: string | undefined;
  if (limitsFor(plan).posLocationsIncluded <= 0) {
    blockedReason = "Extra locations are part of the Pro plan.";
  } else if (!sub || !LIVE_STATES.includes(sub.state)) {
    blockedReason =
      "Extra locations are billed with your subscription. Subscribe to a paid plan to add more shops.";
  } else if (!sub.currentPeriodEnd) {
    blockedReason = "Your billing cycle hasn't started yet. Try again shortly.";
  }

  return {
    included: limitsFor(plan).posLocationsIncluded,
    billed,
    existing,
    allowance: locationAllowance(plan, billed),
    required: requiredBilledLocations(plan, existing),
    releasable: releasableLocations(plan, billed, existing),
    scheduled: sub?.scheduledLocations ?? null,
    // Cached price is right for DISPLAY; the charge re-reads it live.
    pricePerPeriodInr:
      period === "yearly"
        ? input.locationPrice.yearlyInr
        : input.locationPrice.monthlyInr,
    period,
    nextPurchaseInr: Math.round(
      prorationFor({
        from: billed,
        to: billed + 1,
        period,
        periodEnd: sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : now,
        now,
        locationPrice: input.locationPrice,
      }) / 100,
    ),
    canBuy: !blockedReason,
    blockedReason,
  };
}

/**
 * The part-period cost of going from `from` locations to `to`.
 *
 * ★ Delegates to the SAME `prorationPaise` a plan change uses, so a location and
 * a tier are prorated by one rule. Zero when releasing (`to < from`) — a release
 * never moves money.
 */
function prorationFor(input: {
  from: number;
  to: number;
  period: BillingPeriod;
  periodEnd: Date;
  now: Date;
  locationPrice: LocationPrice;
}): number {
  const unit = extraLocationPaise(input.period, input.locationPrice);
  return prorationPaise({
    // Only the LOCATION delta prorates; the plan itself is unchanged, so passing
    // location-only amounts keeps the arithmetic honest.
    currentPeriodPaise: unit * input.from,
    targetPeriodPaise: unit * input.to,
    period: input.period,
    periodEnd: input.periodEnd,
    now: input.now,
    periodDays: PERIOD_DAYS[input.period],
  });
}

export interface LocationPurchaseStart {
  invoiceId: string;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  /** The count this payment buys, echoed so the client cannot drift from it. */
  targetCount: number;
}

/**
 * Begin buying extra locations: issue an addon invoice for the part period and
 * open a Razorpay order for it.
 *
 * ★ THE COUNT IS ABSOLUTE, NEVER A DELTA. Two tabs each pressing "add one"
 * against a delta buys two, and the merchant finds out on their card. An absolute
 * target is idempotent — the second request resolves to the same number.
 *
 * ★ NOTHING IS GRANTED HERE. `billed_locations` moves in
 * `confirmLocationPurchase`, and only against a verified payment.
 */
export async function startLocationPurchase(input: {
  storeId: string;
  store: StorePlanFields;
  requested: number;
  /** LIVE, never cached — this number becomes a charge. */
  locationPrice: LocationPrice;
  now?: Date;
}): Promise<LocationResult<LocationPurchaseStart>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { ok: false, error: "Payments aren't available now." };

  const [sub, existing] = await Promise.all([
    loadSub(input.storeId),
    countLocations(input.storeId),
  ]);
  // Fails closed: unable to read means unable to rule out charging twice.
  if (sub === undefined || existing === null) {
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  if (!sub || !LIVE_STATES.includes(sub.state) || !sub.currentPeriodEnd) {
    return {
      ok: false,
      error:
        "Extra locations are billed with your subscription. Subscribe to a paid plan first.",
    };
  }

  const plan = effectivePlan(input.store);
  const check = validateBilledLocations(plan, input.requested, existing);
  if (!check.ok) return { ok: false, error: check.reason };

  const current = sub.billedLocations;
  if (check.count === current) {
    return { ok: false, error: "That's already how many you have." };
  }
  // Releasing is a different operation — it moves no money and waits for the
  // cycle end. Routing it through a payment would charge for a reduction.
  if (check.count < current) {
    return {
      ok: false,
      error: "Use the release flow to reduce your locations.",
    };
  }

  const period: BillingPeriod = sub.period === "yearly" ? "yearly" : "monthly";
  const amountPaise = prorationFor({
    from: current,
    to: check.count,
    period,
    periodEnd: new Date(sub.currentPeriodEnd),
    now,
    locationPrice: input.locationPrice,
  });

  // ★ At the very end of a cycle the part period rounds to nothing. Charging ₹0
  // is not a payment, and Razorpay refuses it — so grant it and let the next
  // renewal invoice bill it in full. The merchant gains a few hours, which is
  // the right side to err on.
  if (amountPaise <= 0) {
    const written = await writeBilledLocations(input.storeId, check.count, now);
    if (!written) {
      return { ok: false, error: "Couldn't update your locations. Try again." };
    }
    return {
      ok: false,
      error: `Added. You'll be billed for ${check.count === 1 ? "it" : "them"} from your next renewal.`,
    };
  }

  // ★ CHECK THE MANDATE CEILING BEFORE TAKING MONEY. This part-period payment is
  // on-session, so it is not bound by it — but every FUTURE cycle is debited
  // automatically against a ceiling fixed when the merchant authorised autopay,
  // and it cannot be raised without them re-authorising. Selling a location that
  // makes the next renewal undebitable is how a paying merchant is downgraded.
  const ceiling = await mandateCeilingRefusal({
    mandateId: sub.mandateId,
    plan: plan as Plan,
    period,
    targetCount: check.count,
    locationPrice: input.locationPrice,
  });
  if (ceiling) return { ok: false, error: ceiling };

  const tax = await loadTaxContext(input.storeId);
  const built = buildAddonInvoice({
    description: `Extra ${check.count - current === 1 ? "location" : "locations"} · part period to ${new Date(sub.currentPeriodEnd).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}`,
    amountPaise,
    tax,
  });

  // ★ NOT finalized here — the enrolment rule (§34). An addon invoice is an
  // OFFER until it is paid, and finalizing would burn a number in the gapless
  // GST series for a document nobody received, and put "you owe this" on
  // /dashboard/plans for a location that was never granted.
  const parties = await loadInvoiceParties(input.storeId);
  const invoice = await createAddonInvoice({
    ...parties,
    storeId: input.storeId,
    built,
    // What this payment buys, so confirm cannot be talked into a different
    // number by a client that reports one.
    targetCount: check.count,
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
      locations: String(check.count),
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
      invoiceId: invoice.id,
      providerOrderId: order.data.id,
      keyId: creds.keyId,
      amountPaise: due,
      targetCount: check.count,
    },
  };
}

/**
 * Would the next automatic renewal exceed the authorised mandate?
 *
 * Returns a message when it would, null when it is fine. No mandate means manual
 * renewal, which has no ceiling — so this is silent rather than refusing.
 */
async function mandateCeilingRefusal(input: {
  mandateId: string | null;
  plan: Plan;
  period: BillingPeriod;
  targetCount: number;
  locationPrice: LocationPrice;
}): Promise<string | null> {
  if (!input.mandateId) return null;
  let maxPaise: number | null = null;
  try {
    maxPaise = await withService(async (db) => {
      const [row] = await db
        .select({ maxAmountPaise: billingMandates.maxAmountPaise })
        .from(billingMandates)
        .where(
          and(
            eq(billingMandates.id, input.mandateId!),
            eq(billingMandates.status, "active"),
          ),
        )
        .limit(1);
      return row?.maxAmountPaise ?? null;
    });
  } catch (err) {
    logError("billing.locations.mandate", err, { mandateId: input.mandateId });
    // Unknown ceiling: do not block a sale on a read we could not make. The
    // renewal path re-checks and routes to manual payment if it overflows.
    return null;
  }
  if (!maxPaise || maxPaise <= 0) return null;

  const planPaise = 0; // The plan amount is unchanged; only locations grow.
  const target = subscriptionTotalPaise(
    planPaise,
    input.targetCount,
    input.period,
    input.locationPrice,
  );
  if (target <= maxPaise) return null;
  return "That's more than your autopay limit allows. Cancel autopay and subscribe again to authorise a higher amount.";
}

/**
 * Settle a location purchase and grant the locations.
 *
 * ★ THE SIGNATURE IS THE TRUST BOUNDARY, verified against the order WE created.
 * ★ THE COUNT COMES FROM THE INVOICE, never from the client — the number was
 *   fixed when the price was computed, so a client that reports a different one
 *   cannot be granted more than it paid for.
 */
export async function confirmLocationPurchase(input: {
  storeId: string;
  invoiceId: string;
  providerPaymentId: string;
  signature: string;
  now?: Date;
}): Promise<LocationResult<{ billedLocations: number }>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds) return { ok: false, error: "Payments aren't available now." };

  let found: {
    attemptId: string;
    providerOrderId: string | null;
    target: number;
  } | null = null;
  try {
    found = await withService(async (db) => {
      const [inv] = await db
        .select({ target: billingInvoices.addonTargetCount })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, input.invoiceId),
            // Scoped by store: an invoice id alone must never let one merchant
            // settle — or benefit from — another's payment.
            eq(billingInvoices.storeId, input.storeId),
            eq(billingInvoices.kind, "addon"),
          ),
        )
        .limit(1);
      if (!inv || inv.target === null) return null;
      const [att] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
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
        target: inv.target,
      };
    });
  } catch (err) {
    logError("billing.locations.confirm_load", err, {
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
      "billing.locations.bad_signature",
      new Error("signature mismatch"),
      { storeId: input.storeId, invoiceId: input.invoiceId },
    );
    return { ok: false, error: "We couldn't verify that payment." };
  }

  const settled = await settleAttempt(found.attemptId, "captured", {
    providerPaymentId: input.providerPaymentId,
    now,
  });
  if (settled && settled !== "captured") {
    return { ok: false, error: "That payment didn't complete." };
  }

  // Issue the document now that it has really been paid.
  await finalizeInvoice(input.invoiceId, now);

  const written = await writeBilledLocations(input.storeId, found.target, now);
  if (!written) {
    // ★ The money is IN. Never a bare failure — say what happened, because the
    // merchant has paid and the entitlement is the part that did not move.
    return {
      ok: false,
      error:
        "Your payment went through but we couldn't add the location. Contact support — don't pay again.",
    };
  }
  return { ok: true, data: { billedLocations: found.target } };
}

/**
 * Book a REDUCTION for the end of the current cycle.
 *
 * ★ Never immediate, and never refunded. They keep — and keep paying for — what
 * they bought until the cycle they paid for runs out. `scheduled_locations` is
 * what the renewal worker reads when it turns the cycle.
 */
export async function releaseLocations(input: {
  storeId: string;
  store: StorePlanFields;
  requested: number;
  now?: Date;
}): Promise<LocationResult<{ scheduled: number; effectiveAt: string | null }>> {
  const now = input.now ?? new Date();
  const [sub, existing] = await Promise.all([
    loadSub(input.storeId),
    countLocations(input.storeId),
  ]);
  if (sub === undefined || existing === null) {
    return { ok: false, error: "Couldn't check your subscription. Try again." };
  }
  if (!sub || !LIVE_STATES.includes(sub.state)) {
    return { ok: false, error: "You don't have a subscription to change." };
  }

  const plan = effectivePlan(input.store);
  const check = validateBilledLocations(plan, input.requested, existing);
  if (!check.ok) return { ok: false, error: check.reason };
  if (check.count > sub.billedLocations) {
    return { ok: false, error: "Use the buy flow to add locations." };
  }
  if (check.count === sub.billedLocations && sub.scheduledLocations === null) {
    return { ok: false, error: "That's already how many you have." };
  }

  // ★★ REFUSE INSIDE THE COLLECTION WINDOW, and say why. The next cycle's
  // invoice is issued at T−4d and is IMMUTABLE once finalized, so a release
  // booked after that cannot reach it — and `advanceCycle` would still drop the
  // count at the turn, leaving the merchant having paid a full cycle for a shop
  // they no longer have. Refusing for a few days beats an overcharge nobody
  // notices, and the message names the date so it does not read as a bug.
  //
  // Closing this properly needs the scheduled change to carry the cycle it
  // applies from — a column, and a change to `advanceCycle`. Worth doing if
  // merchants hit it; the refusal is honest until then.
  if (await nextInvoiceIssued(input.storeId, sub.currentCycleSeq + 1)) {
    return {
      ok: false,
      error: sub.currentPeriodEnd
        ? `Your next invoice has already been issued. You can release locations again after ${new Date(sub.currentPeriodEnd).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}.`
        : "Your next invoice has already been issued. Try again after it renews.",
    };
  }

  try {
    await withService(async (db) => {
      await db
        .update(billingSubscriptions)
        .set({
          // Equal to the current count = cancel a previously booked release.
          scheduledLocations:
            check.count === sub.billedLocations ? null : check.count,
          updatedAt: now.toISOString(),
        })
        .where(eq(billingSubscriptions.storeId, input.storeId));
    });
  } catch (err) {
    logError("billing.locations.release", err, { storeId: input.storeId });
    return { ok: false, error: "Couldn't schedule that change. Try again." };
  }

  return {
    ok: true,
    data: {
      scheduled: check.count,
      effectiveAt: sub.currentPeriodEnd,
    },
  };
}

/**
 * Has the invoice for `cycleSeq` already been raised?
 *
 * ★ Fails toward REFUSING (returns true on a read error): booking a release we
 * cannot price correctly is the outcome that silently takes money.
 */
async function nextInvoiceIssued(
  storeId: string,
  cycleSeq: number,
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
            eq(billingInvoices.cycleSeq, cycleSeq),
          ),
        )
        .limit(1);
      return !!row;
    });
  } catch (err) {
    logError("billing.locations.next_invoice", err, { storeId, cycleSeq });
    return true;
  }
}

/** Set the paid count. Used only after money has moved, or when it costs nothing. */
async function writeBilledLocations(
  storeId: string,
  count: number,
  now: Date,
): Promise<boolean> {
  try {
    await withService(async (db) => {
      await db
        .update(billingSubscriptions)
        .set({
          billedLocations: count,
          // Buying supersedes a booked release: they clearly want the shops.
          scheduledLocations: null,
          updatedAt: now.toISOString(),
        })
        .where(eq(billingSubscriptions.storeId, storeId));
    });
    return true;
  } catch (err) {
    logError("billing.locations.write", err, { storeId, count });
    return false;
  }
}
