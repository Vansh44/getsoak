// ---------------------------------------------------------------------------
// Metered extra locations — the arithmetic and the rules, on their own so they
// can be tested without a gateway or a database (roadmap Step 5 / POS Phase 7).
//
// THE MODEL: an extra location is a PRICE RISE ON THE SAME SUBSCRIPTION, not a
// second one.
//
// Razorpay bills a subscription against a Plan whose amount is fixed, so the
// obvious alternatives were a second mandate (the merchant authorises autopay
// twice, and can then have one succeed while the other halts) or per-cycle
// add-ons (a charge someone has to remember to add at every renewal, forever).
// Folding the cost into the plan amount instead means the whole existing
// machinery already applies:
//
//   * `razorpay_plans` is keyed on (plan, period, AMOUNT), so a different
//     location count resolves to a different cached plan id with no new table;
//   * `planForRzpPlan` maps that id back to (tier, period) for the webhook,
//     which is unaffected because the tier did not change;
//   * `decidePlanChange` already says dearer-applies-now / cheaper-waits, so
//     adding a location prorates and removing one takes effect at cycle end;
//   * the mandate ceiling already carries headroom, so no re-authorisation.
//
// The merchant sees one line, one charge date, one mandate.
// ---------------------------------------------------------------------------

import { EXTRA_LOCATION_PRICE, limitsFor } from "@/lib/plans";

export type BillingPeriod = "monthly" | "yearly";

/**
 * A sanity ceiling on extra locations, NOT a business limit.
 *
 * It exists because the count reaches `rzpUpdateSubscription` as an amount: a
 * fat-fingered or hostile 10,000 would mint a Razorpay plan for ₹1 crore a
 * month and try to charge it against a live mandate. A real merchant on this
 * product has tens of shops at most, and one who genuinely outgrows this wants
 * a conversation rather than a form.
 */
export const MAX_EXTRA_LOCATIONS = 50;

/**
 * What one extra location costs, in rupees, for each period.
 *
 * A parameter rather than a module-level read, because a platform operator sets
 * this from the console (`plan_prices`, key `extra_location`) and this module
 * must stay pure — the same shape `subscriptionTotalPaise` uses for the plan
 * price. Callers that CHARGE pass the live value
 * (`getExtraLocationPricingLive`); the default is the code constant, which is
 * what applies until an operator has ever set one.
 */
export interface LocationPrice {
  monthlyInr: number;
  yearlyInr: number;
}

/** Per-location price for a period, in paise. */
export function extraLocationPaise(
  period: BillingPeriod,
  price: LocationPrice = EXTRA_LOCATION_PRICE,
): number {
  const inr = period === "yearly" ? price.yearlyInr : price.monthlyInr;
  // A missing or junk override must not become NaN paise on an invoice — fall
  // back to the compiled-in price rather than charging nothing or crashing.
  if (!Number.isFinite(inr) || inr < 0) {
    return (
      (period === "yearly"
        ? EXTRA_LOCATION_PRICE.yearlyInr
        : EXTRA_LOCATION_PRICE.monthlyInr) * 100
    );
  }
  return Math.round(inr * 100);
}

/**
 * What the subscription should cost: the tier's own price plus the locations
 * bought on top of it.
 *
 * `planPaise` is passed in rather than read here because it is the LIVE price
 * (an operator can reprice, and an existing subscriber may be grandfathered) —
 * this module must stay pure.
 */
export function subscriptionTotalPaise(
  planPaise: number,
  extraLocations: number,
  period: BillingPeriod,
  price?: LocationPrice,
): number {
  const extra = Math.max(0, Math.floor(extraLocations || 0));
  return planPaise + extra * extraLocationPaise(period, price);
}

/**
 * How many locations a store may have: what the plan includes, plus what it is
 * paying for.
 *
 * ★ `billed` is only ever ADDITIVE to the plan's allowance. It is not a total,
 * so a plan whose included count later rises does not silently charge the
 * merchant for locations they now get free — they simply gain headroom, and
 * `releasableLocations` below is what lets them stop paying for the overlap.
 */
export function locationAllowance(plan: unknown, billed: number): number {
  const included = limitsFor(plan).posLocationsIncluded;
  // A plan with no POS at all includes nothing, and paying for extras cannot
  // buy POS — so a lapsed Pro store keeps its locations (nothing is deleted)
  // but may not create more. Soft-on-downgrade, invariant 1.
  if (included <= 0) return 0;
  return included + Math.max(0, Math.floor(billed || 0));
}

/** May another location be created right now? */
export function canAddLocation(
  plan: unknown,
  billed: number,
  existing: number,
): boolean {
  return existing < locationAllowance(plan, billed);
}

/**
 * How many extra locations a store must be paying for to hold `existing` of
 * them. Zero while it is inside the included allowance.
 *
 * This is the number the purchase flow quotes, and the floor
 * `changeBilledLocations` refuses to go below — releasing a location you are
 * still using would put the store over its allowance with no way to get back
 * under it except deleting a shop, which invariant 1 forbids doing on its
 * behalf.
 */
export function requiredBilledLocations(
  plan: unknown,
  existing: number,
): number {
  const included = limitsFor(plan).posLocationsIncluded;
  if (included <= 0) return 0;
  return Math.max(0, Math.ceil(existing - included));
}

/** How many paid slots are sitting unused, and could be released to stop
 *  paying for them. */
export function releasableLocations(
  plan: unknown,
  billed: number,
  existing: number,
): number {
  const needed = requiredBilledLocations(plan, existing);
  return Math.max(0, Math.floor(billed || 0) - needed);
}

export type LocationChangeRefusal =
  | { ok: true; count: number }
  | { ok: false; reason: string };

/**
 * Validate a requested billed-location count before any money moves.
 *
 * Refuses rather than clamping, in both directions. Clamping a too-large
 * request would charge a merchant for a number they did not choose; clamping a
 * too-small one would quietly leave them paying for a location they asked to
 * release, which is the failure mode they would notice on their card and not in
 * the UI.
 */
export function validateBilledLocations(
  plan: unknown,
  requested: number,
  existing: number,
): LocationChangeRefusal {
  if (!Number.isInteger(requested) || requested < 0) {
    return { ok: false, reason: "Choose a whole number of extra locations." };
  }
  if (limitsFor(plan).posLocationsIncluded <= 0) {
    return {
      ok: false,
      reason:
        "Extra locations are part of the Pro plan. Upgrade to Pro to add more shops.",
    };
  }
  if (requested > MAX_EXTRA_LOCATIONS) {
    return {
      ok: false,
      reason: `You can add up to ${MAX_EXTRA_LOCATIONS} extra locations here. Get in touch if you need more.`,
    };
  }
  const needed = requiredBilledLocations(plan, existing);
  if (requested < needed) {
    return {
      ok: false,
      reason:
        needed === 1
          ? "You're using 1 extra location. Delete or deactivate it before you stop paying for it."
          : `You're using ${needed} extra locations. Remove the ones you don't need before reducing this.`,
    };
  }
  return { ok: true, count: requested };
}

/** What the merchant is told before they confirm. */
export function describeLocationChange(
  from: number,
  to: number,
  period: BillingPeriod,
  locationPrice?: LocationPrice,
): string {
  const each = period === "yearly" ? "year" : "month";
  // Derived from the same paise figure the charge uses, so the sentence a
  // merchant reads before confirming can never quote a different number from
  // the one that reaches their card.
  const price = (
    extraLocationPaise(period, locationPrice) / 100
  ).toLocaleString("en-IN");

  if (to > from) {
    const n = to - from;
    // Dearer, so it applies NOW and Razorpay prorates — the same sentence
    // describePlanChange uses, for the same reason: the merchant should know a
    // charge is about to happen before they press the button, not after.
    return `Adding ${n} location${n === 1 ? "" : "s"} at ₹${price}/${each} each. You'll be charged the difference for the rest of this cycle, and ₹${price} per location each ${each} after that.`;
  }
  const n = from - to;
  return `Releasing ${n} location${n === 1 ? "" : "s"}. You keep them until the end of this billing cycle, then stop paying for them. Nothing is charged today.`;
}
