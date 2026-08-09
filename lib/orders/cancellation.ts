// ---------------------------------------------------------------------------
// When a customer may cancel, and what a cancellation records — the rules on
// their own, so they can be tested without a database (roadmap Step 2).
//
// ★ WHOLE-ORDER ONLY. There is no item-level cancellation here and none is
// coming: this product has no partial fulfilment, so an order is either
// cancelled or it is not. Everything below takes an ORDER and returns one
// answer about that order. If per-item ever arrives it will arrive with partial
// fulfilment, and it will not be by widening these functions.
//
// ★ THE REQUEST IS NOT THE CANCELLATION. A customer raises a request; a
// merchant approves it. That indirection is the whole point — money and stock
// move on approval, not on asking — and it is why `cancellation_status` exists
// alongside `orders.status` rather than being folded into it.
// ---------------------------------------------------------------------------

/** Statuses a customer may still ask to cancel from. Anything further along is
 *  the merchant's call, not a self-serve action. */
export const SELF_CANCELLABLE_STATUSES = ["pending", "processing"] as const;

/**
 * The merchant's cancellation window.
 *
 * A fixed list rather than a free number of hours, because "until it ships" is
 * the rule most merchants actually mean and cannot be expressed as a duration —
 * a shop that packs in 20 minutes and one that packs in three days both want
 * "before we've packed it", not a guess at their own turnaround.
 */
export type CancellationWindow =
  | "none"
  | "until_fulfilled"
  | "1h"
  | "24h"
  | "custom";

export function normalizeWindow(v: unknown): CancellationWindow {
  return v === "none" ||
    v === "until_fulfilled" ||
    v === "1h" ||
    v === "24h" ||
    v === "custom"
    ? v
    : "until_fulfilled";
}

export type CancellationApproval = "require_approval" | "auto";

/** Unknown resolves to requiring approval — the safe half. An automatic
 *  approval moves money with nobody looking, so it is never the fallback. */
export function normalizeApproval(v: unknown): CancellationApproval {
  return v === "auto" ? "auto" : "require_approval";
}

/** Statuses that mean the goods are on their way or already handed over. */
const FULFILLED_STATUSES = ["shipped", "delivered", "completed"] as const;

export function isFulfilled(status: string | null | undefined): boolean {
  return (FULFILLED_STATUSES as readonly string[]).includes(status ?? "");
}

export interface CancellationRules {
  /** `orders.allowCustomerCancellation`. */
  allowed: boolean;
  window: CancellationWindow;
  /** Hours, used only when `window` is "custom". */
  customHours: number;
  approval: CancellationApproval;
}

export interface CancellableOrder {
  status: string | null;
  /** ISO string. */
  createdAt: string | null;
  /** Set once a pickup has been handed over. */
  collectedAt?: string | null;
  /** Whatever is already recorded about a cancellation request. */
  cancellationStatus?: string | null;
}

export type CancelEligibility =
  | { ok: true }
  | { ok: false; code: CancelRefusal; reason: string };

export type CancelRefusal =
  | "disabled"
  | "already_cancelled"
  | "already_requested"
  | "fulfilled"
  | "window_expired"
  | "not_cancellable";

/**
 * May this customer raise a cancellation request right now?
 *
 * ★ THE SAME FUNCTION ANSWERS FOR THE BUTTON AND FOR THE SERVER. The order page
 * asks it whether to render the control; the action asks it again before
 * writing anything. A window that is only enforced in the browser is not
 * enforced (roadmap invariant 5), and re-implementing the rule server-side is
 * how the two drift.
 *
 * `now` is injected so the window is testable without waiting.
 */
export function canCustomerCancel(
  order: CancellableOrder,
  rules: CancellationRules,
  now: Date = new Date(),
): CancelEligibility {
  if (!rules.allowed || rules.window === "none") {
    return {
      ok: false,
      code: "disabled",
      reason:
        "This store handles cancellations directly — please contact them.",
    };
  }
  if (order.status === "cancelled") {
    return {
      ok: false,
      code: "already_cancelled",
      reason: "This order is already cancelled.",
    };
  }
  // ★ ONE ACTIVE REQUEST PER ORDER. A second would give the merchant two rows
  // to decide about for one order, and a declined one must not be reopened by
  // simply asking again — that would make "declined" meaningless.
  if (order.cancellationStatus === "requested") {
    return {
      ok: false,
      code: "already_requested",
      reason:
        "You've already asked to cancel this order. The store is reviewing it.",
    };
  }
  if (order.cancellationStatus === "declined") {
    return {
      ok: false,
      code: "already_requested",
      reason:
        "The store declined an earlier cancellation request for this order. Please contact them.",
    };
  }
  // Collected or fulfilled: the goods have gone. This is a return, not a
  // cancellation, and conflating them would put stock back that is in a
  // customer's hands.
  if (order.collectedAt || isFulfilled(order.status)) {
    return {
      ok: false,
      code: "fulfilled",
      reason:
        "This order has already been fulfilled, so it can't be cancelled. You may be able to return it instead.",
    };
  }
  if (
    !(SELF_CANCELLABLE_STATUSES as readonly string[]).includes(
      order.status ?? "",
    )
  ) {
    return {
      ok: false,
      code: "not_cancellable",
      reason: "This order has moved on and can't be cancelled now.",
    };
  }

  // "Until fulfilled" is a FIRST-CLASS rule, not a very long duration. Having
  // got past the fulfilment check above, there is nothing left to test.
  if (rules.window === "until_fulfilled") return { ok: true };

  const hours = windowHours(rules);
  const placedAt = order.createdAt ? Date.parse(order.createdAt) : NaN;
  // ★ A DATELESS ORDER IS NOT AN EXPIRED ONE. Refusing a genuine cancellation
  // because a legacy row has no timestamp makes the customer pay for our data
  // problem — the same fail-open posture lib/returns/eligibility.ts takes.
  if (!Number.isFinite(placedAt)) return { ok: true };

  if (now.getTime() - placedAt > hours * 3_600_000) {
    return {
      ok: false,
      code: "window_expired",
      reason: `Cancellations are only accepted within ${describeWindow(rules)} of ordering. Please contact the store.`,
    };
  }
  return { ok: true };
}

/** Hours the window allows. Only meaningful for the duration windows. */
export function windowHours(rules: CancellationRules): number {
  if (rules.window === "1h") return 1;
  if (rules.window === "24h") return 24;
  const n = Number(rules.customHours);
  // A custom window of zero or junk would silently refuse every cancellation
  // while the setting reads as enabled; fall back to a day.
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/** Human phrasing for the window, for customer-facing copy. */
export function describeWindow(rules: CancellationRules): string {
  switch (rules.window) {
    case "none":
      return "no cancellations";
    case "until_fulfilled":
      return "until the order is fulfilled";
    case "1h":
      return "1 hour";
    case "24h":
      return "24 hours";
    default: {
      const h = windowHours(rules);
      return h === 1 ? "1 hour" : `${h} hours`;
    }
  }
}

// ---------------------------------------------------------------------------
// Why an order was cancelled
//
// ★ A FIXED LIST IN CODE, not merchant-editable text — the same decision
// lib/returns/reasons.ts records. Free text makes the data useless the moment
// you have two stores ("staff error" vs "Staff Error" vs "our mistake"), and
// this vocabulary is what any future cancellation report has to group by.
// ---------------------------------------------------------------------------

export const CANCEL_REASONS = [
  { code: "customer_changed_mind", label: "Customer changed their mind" },
  { code: "fraudulent", label: "Fraudulent order" },
  { code: "items_unavailable", label: "Items unavailable" },
  { code: "payment_declined", label: "Payment declined" },
  { code: "staff_error", label: "Staff error" },
  { code: "other", label: "Other" },
] as const;

export type CancelReasonCode = (typeof CANCEL_REASONS)[number]["code"];

export function isCancelReason(v: unknown): v is CancelReasonCode {
  return CANCEL_REASONS.some((r) => r.code === v);
}

export function cancelReasonLabel(code: string | null | undefined): string {
  return CANCEL_REASONS.find((r) => r.code === code)?.label ?? "Other";
}

// ---------------------------------------------------------------------------
// Where the money goes
// ---------------------------------------------------------------------------

/**
 * ★ "LATER" IS A REAL CHOICE, NOT AN ABSENCE. Cancelling does not have to move
 * money in the same breath — a merchant may be waiting on a decision, or may
 * settle it offline. Recording that explicitly is what keeps the refund panel
 * honest afterwards: the order shows what is still owed rather than looking
 * settled because nobody was asked.
 */
export type RefundDestination = "original" | "store_credit" | "later";

export function isRefundDestination(v: unknown): v is RefundDestination {
  return v === "original" || v === "store_credit" || v === "later";
}

/**
 * Which destinations can actually be offered for this order.
 *
 * Refusing an impossible one up front beats letting a merchant pick it and
 * watching it fail: `original` needs money to have been taken online, and
 * `store_credit` needs somebody to credit.
 */
export function refundDestinationsFor(order: {
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  customerId?: string | null;
}): RefundDestination[] {
  const paid = order.paymentStatus === "paid";
  const gateway = order.paymentMethod === "razorpay";
  const out: RefundDestination[] = [];
  if (paid && gateway) out.push("original");
  if (paid && order.customerId) out.push("store_credit");
  // Always available: it records an obligation rather than moving money, and a
  // COD order that was never paid still needs a way to say "nothing owed".
  out.push("later");
  return out;
}

// ---------------------------------------------------------------------------
// Reading the merchant's rules out of the settings registry.
//
// Kept here, beside the rules that consume it, so every caller resolves the
// same shape — the storefront button, the customer action and the merchant's
// review queue all need it, and three hand-written reads is three chances to
// disagree about what "custom" means.
// ---------------------------------------------------------------------------

/** Fold resolved store settings into the rules. Pure: the caller does the read. */
export function rulesFromSettings(settings: {
  [k: string]: boolean | number | string;
}): CancellationRules {
  const hours = Number(settings["orders.cancellationWindowHours"]);
  return {
    allowed: settings["orders.allowCustomerCancellation"] === true,
    window: normalizeWindow(settings["orders.cancellationWindow"]),
    customHours: Number.isFinite(hours) && hours > 0 ? hours : 24,
    approval: normalizeApproval(settings["orders.cancellationApproval"]),
  };
}
