/**
 * Billing cycle, grace window, collection eligibility and mandate sizing.
 *
 * PURE — no DB, no gateway, no clock of its own. Every function takes the
 * instant it needs, so all of it is testable and none of it can disagree with
 * itself across callers. Design: docs/billing-architecture.md.
 *
 * Money is integer PAISE throughout. Never floats — see roundUpTo.
 */

import type { BillingPeriod } from "@/lib/plans/location-billing";

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

/**
 * How long a billing period lasts, in days.
 *
 * ★ A DURATION, never a calendar unit. 30 days means exactly 30 days and 365
 * means exactly 365 — February, month lengths and leap years get no special
 * case anywhere in this file, which is the whole point (owner decision,
 * 2026-08-11).
 *
 * ⚠ Two consequences, both intended, both pinned by tests:
 *   • The billing date DRIFTS. A cycle starting 1 Aug renews on the 31st, then
 *     the 30th. "We bill on the 1st" is never true and must not be shown.
 *   • A 365-day year is not an anniversary. A cycle starting 1 Jan 2028 (a leap
 *     year) ends 31 Dec 2028. Do not "fix" this into date arithmetic.
 */
export const PERIOD_DAYS: Record<BillingPeriod, number> = {
  monthly: 30,
  yearly: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days → ms. Exact: no DST to absorb, since everything is UTC instants. */
function days(n: number): number {
  return n * DAY_MS;
}

export interface Cycle {
  /** Inclusive start of the service period. */
  start: Date;
  /** Exclusive end — also the next cycle's start, so periods never overlap. */
  end: Date;
  /** Monotonic counter. The idempotency key for the renewal invoice. */
  seq: number;
}

/**
 * The cycle that begins at `start`.
 *
 * `end` is EXCLUSIVE and is byte-identical to the next cycle's `start`, so
 * consecutive cycles tile the timeline with no gap and no overlap — an order
 * placed in the boundary millisecond belongs to exactly one of them.
 */
export function cycleFrom(
  start: Date,
  period: BillingPeriod,
  seq: number,
): Cycle {
  return {
    start,
    end: new Date(start.getTime() + days(PERIOD_DAYS[period])),
    seq,
  };
}

/** The cycle following `current`, at the same period length. */
export function nextCycle(current: Cycle, period: BillingPeriod): Cycle {
  return cycleFrom(current.end, period, current.seq + 1);
}

// ---------------------------------------------------------------------------
// Collection timing — the X+3 rule
// ---------------------------------------------------------------------------

/**
 * How far BEFORE cycle start the invoice is finalized and the debit initiated.
 *
 * ★★ Four days, and this number is load-bearing. RBI requires a pre-debit
 * notification at least 24h ahead, and Razorpay's guidance is that a recurring
 * payment takes X+3 days to confirm — a debit scheduled for the 1st is
 * processed on the 4th. Collect AT cycle start and the 2-day grace period would
 * expire before the payment result is even known, downgrading merchants whose
 * money is still in flight. That is Rule 6, violated by a scheduling mistake.
 *
 * ⚠ Raising this widens the window in which the amount is frozen but the cycle
 * has not started — which is when a location added "now" lands on the NEXT
 * invoice. Lowering it below 4 re-opens the race above.
 */
export const COLLECTION_LEAD_DAYS = 4;

/** When the renewal invoice is finalized and the debit initiated. */
export function collectionStartsAt(cycleStart: Date): Date {
  return new Date(cycleStart.getTime() - days(COLLECTION_LEAD_DAYS));
}

/**
 * The latest cycle start that is due for collection at `now` — i.e. the upper
 * bound for a worker's "which subscriptions do I bill?" query.
 *
 * The inverse of `collectionStartsAt`, expressed the way a WHERE clause needs
 * it: a cycle beginning at or before this instant should already be collected.
 */
export function collectionCutoff(now: Date): Date {
  return new Date(now.getTime() + days(COLLECTION_LEAD_DAYS));
}

/**
 * Is it time to finalize and collect for a cycle starting at `cycleStart`?
 * Inclusive, so a worker firing exactly on the boundary does the work rather
 * than waiting a full tick.
 */
export function isCollectionDue(cycleStart: Date, now: Date): boolean {
  return now.getTime() >= collectionStartsAt(cycleStart).getTime();
}

// ---------------------------------------------------------------------------
// The grace window
// ---------------------------------------------------------------------------

/**
 * The payment buffer, in hours (owner decision: 2 days, as specified).
 *
 * ★ It starts when a payment is KNOWN to have FAILED — never when the invoice
 * was created, and never on an `unknown` outcome. A provider timeout means we
 * do not know whether money moved; starting a downgrade clock on that is the
 * single worst thing this system could do (Rule 6).
 */
export const GRACE_HOURS = 48;

/** When the buffer expires, given the instant the failure was established. */
export function graceEndsAt(failedAt: Date): Date {
  return new Date(failedAt.getTime() + GRACE_HOURS * 60 * 60 * 1000);
}

/**
 * Has the buffer run out?
 *
 * ★ STRICTLY greater than. At exactly `graceEndsAt` the merchant still has the
 * full 48 hours they were promised — spec §37's "payment succeeds at
 * 23:59:59.999" case resolves in the merchant's favour rather than on a
 * millisecond. The authoritative check is still the conditional claim in SQL;
 * this only decides whether to attempt it.
 */
export function isGraceExpired(graceEnds: Date, now: Date): boolean {
  return now.getTime() > graceEnds.getTime();
}

// ---------------------------------------------------------------------------
// Automatic-collection eligibility
// ---------------------------------------------------------------------------

/**
 * The most that may be debited against a mandate WITHOUT the customer
 * authenticating that specific debit.
 *
 * RBI Digital Payments — E-mandate Framework, 2026: "Recurring transactions up
 * to Rs. 15,000 per transaction may be processed without AFA." Applies to UPI,
 * cards and PPIs alike. Raised from ₹5,000 on 16 June 2022.
 *
 * ★★ NOT the same thing as a mandate's registered `max_amount`, which can be
 * far larger (₹1,00,000+ on UPI, effectively uncapped on cards). A mandate
 * registered for ₹2,00,000 does not make a ₹50,000 debit automatic — it makes
 * it PERMITTED. Conflating the two is the most common error in this area.
 *
 * ⚠ The ₹1,00,000 AFA exemption is real but reaches only insurance premiums,
 * mutual fund subscriptions and credit card bills. A SaaS subscription is none
 * of those; do not raise this constant without written confirmation from the
 * acquirer that StoreMink's MCC qualifies.
 */
export const AFA_EXEMPT_LIMIT_PAISE = 15_000 * 100;

export type MandateStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "failed"
  | "unknown";

export interface CollectionCheck {
  mandateStatus: MandateStatus | null;
  /** What the merchant authorised. Null when we never captured it. */
  mandateMaxPaise: number | null;
  totalPaise: number;
}

export type CollectionRoute =
  | { auto: true }
  | { auto: false; reason: "no_mandate" | "over_mandate" | "over_afa_limit" };

/**
 * Can this invoice be collected with no merchant involvement?
 *
 * A CONJUNCTION, not one comparison — both ceilings, always:
 *   • within what was authorised (or the gateway refuses outright), and
 *   • within the AFA-exempt limit (or the merchant must authenticate, which is
 *     not automatic in any sense the billing worker cares about).
 *
 * ★ `unknown` and `pending` are NOT eligible. A mandate we have not confirmed
 * must be verified, never assumed — spec §17.
 * ★ A null `mandateMaxPaise` fails CLOSED. The cost of being wrong is one
 * manual payment; the cost of assuming headroom we never recorded is a debit
 * the gateway rejects at renewal, which spends the grace period.
 */
export function collectionRoute(c: CollectionCheck): CollectionRoute {
  if (c.mandateStatus !== "active")
    return { auto: false, reason: "no_mandate" };
  if (c.mandateMaxPaise === null || c.totalPaise > c.mandateMaxPaise) {
    return { auto: false, reason: "over_mandate" };
  }
  if (c.totalPaise > AFA_EXEMPT_LIMIT_PAISE) {
    return { auto: false, reason: "over_afa_limit" };
  }
  return { auto: true };
}

// ---------------------------------------------------------------------------
// Mandate sizing
// ---------------------------------------------------------------------------

/**
 * ★★ Tax provision, in basis points. Applied even while `tax_enabled` is
 * false.
 *
 * GST is off today and gets switched on from the operator dashboard later. A
 * mandate sized on the bare plan price would be REFUSED at the first post-GST
 * renewal — Basic yearly goes ₹15,000 → ₹17,700 — for every merchant who
 * signed up before the switch, with no way to raise it except re-authorising.
 * Provisioning for tax up front costs nothing: a mandate is a ceiling, not a
 * charge.
 */
export const TAX_PROVISION_BPS = 11_800; // 1.18×

/** Room for a future reprice, so an operator raising a price does not lock
 *  existing subscribers out of their own renewal. */
export const REPRICE_HEADROOM_BPS = 15_000; // 1.5×

/** Mandate ceilings are rounded up to a round rupee figure — the merchant
 *  reads this number on the authorisation screen. */
const MANDATE_ROUNDING_PAISE = 1_000 * 100;

/**
 * ★★ RAZORPAY'S OWN CEILING on `token.max_amount` for a UPI mandate: ₹99,999.
 * Documented in their recurring-payments API reference (checked 2026-08-14).
 *
 * A provisioned size above this has its AUTHORISATION ORDER REJECTED by the
 * gateway — not the renewal, the setup — so without checking it the biggest
 * merchants would be the only ones unable to configure autopay, and the error
 * would arrive from Razorpay with nothing explaining it. Pro yearly with five
 * extra locations already reaches ₹1,16,000.
 *
 * Use `mandateFitsGateway` rather than clamping to it; see the note there.
 */
export const MANDATE_MAX_GATEWAY_PAISE = 9_999_900;

function roundUpTo(paise: number, step: number): number {
  return Math.ceil(paise / step) * step;
}

/**
 * How large a mandate to ask a merchant to authorise.
 *
 * ★ THE MANDATE MUST COVER THE RENEWAL. It need NOT cover every possible
 * future purchase. A failed renewal costs a grace period, a downgrade and
 * possibly the merchant; an upgrade that needs re-authorisation happens while
 * the merchant is on screen taking a deliberate action, which is a fine place
 * for friction. The superseded `mandateMaxPaise()` had this backwards — it
 * loaded all the headroom onto signup, where it costs conversion, to spare
 * discretionary purchases where nobody would have minded.
 *
 * So: size on what renewal will ACTUALLY cost — the plan plus the locations
 * they are billed for today, not the top plan plus ten locations they cannot
 * buy.
 */
export function mandateSizePaise(input: {
  planPaise: number;
  /** Cost of the locations this merchant is billed for TODAY. 0 for a plan
   *  with no POS, which cannot buy them at all. */
  locationsPaise?: number;
  /**
   * Do the listed prices already include tax
   * (`platform_billing_settings.tax_inclusive`)?
   *
   * ★ The tax provision exists ONLY for exclusive pricing, where switching GST
   * on later raises every bill by 18% against a ceiling that was authorised
   * before the switch. Under inclusive pricing the charge never moves, so
   * provisioning for it would quote the merchant a needlessly alarming number
   * on the authorisation screen — which is the thing this function was rewritten
   * to stop doing.
   */
  taxInclusive?: boolean;
}): number {
  const base =
    Math.max(0, Math.round(input.planPaise)) +
    Math.max(0, Math.round(input.locationsPaise ?? 0));
  const taxBps = input.taxInclusive ? 10_000 : TAX_PROVISION_BPS;
  const provisioned = Math.ceil(
    (base * taxBps * REPRICE_HEADROOM_BPS) / (10_000 * 10_000),
  );
  return roundUpTo(provisioned, MANDATE_ROUNDING_PAISE);
}

/**
 * Can a mandate this size exist at all?
 *
 * ★★ ASKED INSTEAD OF CLAMPING, and the difference matters. Capping the size at
 * the ceiling would let the authorisation succeed and then leave every renewal
 * above it routing to manual — so the merchant authorises autopay, is told it
 * is set up, and is invoiced by hand forever. That is precisely the
 * "promise a charge that never comes" failure the activation email was fixed
 * for. Better to not offer autopay to a merchant we cannot collect from, and
 * say so.
 */
export function mandateFitsGateway(sizePaise: number): boolean {
  return sizePaise <= MANDATE_MAX_GATEWAY_PAISE;
}
