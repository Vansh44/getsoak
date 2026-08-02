// Can this come back, and until when? (docs/returns-exchanges-plan.md §2, §6.1)
//
// PURE. The whole point is that ONE function answers this for the storefront
// badge, the customer's request form, the dashboard's review queue and the
// till — because four hand-written versions of "is it still in the window"
// will disagree, and the customer will find the one that says yes.
//
// ── The window starts at DELIVERY ──────────────────────────────────────────
// ★ Measured from `created_at`, a 7-day window on a 10-day delivery has
// expired before the customer ever held the goods. `orders.delivered_at`
// exists for exactly this (refunds_01_gateway.sql).
//
// Fallback chain, in order:
//   delivered_at  → it landed
//   collected_at  → they picked it up (a pickup order never "delivers")
//   created_at    → a POS sale: they walked out with it
//
// ── Undelivered is NOT ineligible ──────────────────────────────────────────
// An order still in transit has no start date yet, so its window has not begun
// — which is different from having run out. Treating those the same would tell
// a customer their brand-new order is too old to return.

export type ReturnBlockedReason =
  | "returns_disabled"
  | "final_sale"
  | "window_expired"
  | "not_yet_delivered"
  | "order_not_eligible"
  | "already_returned";

export interface ReturnPolicySettings {
  /** `returns.enabled` — the master switch. */
  enabled: boolean;
  /** `returns.windowDays` — the store default. */
  windowDays: number;
}

export interface ReturnableOrderInfo {
  status: string;
  /** ISO timestamps, or null. */
  deliveredAt?: string | null;
  collectedAt?: string | null;
  createdAt?: string | null;
}

export interface ReturnableProductInfo {
  /** `products.returnable` — FALSE is final sale. */
  returnable?: boolean | null;
  /** `products.return_window_days` — NULL uses the store's. */
  returnWindowDays?: number | null;
}

export interface ReturnEligibility {
  eligible: boolean;
  /** Absent when eligible. */
  reason?: ReturnBlockedReason;
  /** When the window closes, ISO. Null when it hasn't started. */
  until: string | null;
  /** Whole days left, floored at 0. Null when the window hasn't started. */
  daysLeft: number | null;
}

/**
 * Order statuses whose goods are actually in the customer's hands.
 *
 * `completed` is the POS sale — rung and handed over. A `cancelled` or
 * `refunded` order has nothing to send back, and `pending`/`processing`/
 * `shipped` haven't arrived, which is a different answer (see below).
 */
const DELIVERED_STATUSES = ["delivered", "completed"];
const IN_FLIGHT_STATUSES = ["pending", "processing", "shipped"];

const DAY_MS = 86_400_000;

/** When the customer took possession — the moment the clock starts. */
export function possessionDate(order: ReturnableOrderInfo): Date | null {
  const raw = order.deliveredAt ?? order.collectedAt ?? null;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // A POS sale has neither: the customer walked out with it at sale time.
  if (order.status === "completed" && order.createdAt) {
    const d = new Date(order.createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Whether one line of one order can still be sent back.
 *
 * `now` is injectable so tests don't depend on the clock, and so a caller
 * rendering a list resolves every row against the SAME instant — otherwise a
 * long page can show two items with the same policy expiring on different days.
 */
export function returnEligibility(
  order: ReturnableOrderInfo,
  product: ReturnableProductInfo | null | undefined,
  settings: ReturnPolicySettings,
  now: Date = new Date(),
): ReturnEligibility {
  const none = { until: null, daysLeft: null };

  if (!settings.enabled) {
    return { eligible: false, reason: "returns_disabled", ...none };
  }

  // Final sale beats everything, including a still-open window: the merchant
  // said this item never comes back.
  if (product && product.returnable === false) {
    return { eligible: false, reason: "final_sale", ...none };
  }

  if (!DELIVERED_STATUSES.includes(order.status)) {
    // Still on its way ⇒ the window hasn't STARTED. Distinct from expired, and
    // the UI must say so differently or a day-old order reads as too late.
    if (IN_FLIGHT_STATUSES.includes(order.status)) {
      return { eligible: false, reason: "not_yet_delivered", ...none };
    }
    // Cancelled, refunded, or anything else: there is nothing to send back.
    return { eligible: false, reason: "order_not_eligible", ...none };
  }

  const start = possessionDate(order);
  if (!start) {
    // Marked delivered but with no timestamp — a legacy row the backfill
    // couldn't date. Fail OPEN: refusing a genuine return because OUR data is
    // incomplete is the store's problem to eat, not the customer's.
    return { eligible: true, until: null, daysLeft: null };
  }

  // A per-product override of 0 is meaningful ("same day only"), so it must
  // survive the ?? — which is why this is a null check and not `||`.
  const days =
    product?.returnWindowDays == null
      ? Math.max(0, Number(settings.windowDays) || 0)
      : Math.max(0, product.returnWindowDays);

  const until = new Date(start.getTime() + days * DAY_MS);
  const msLeft = until.getTime() - now.getTime();

  if (msLeft < 0) {
    return {
      eligible: false,
      reason: "window_expired",
      until: until.toISOString(),
      daysLeft: 0,
    };
  }

  return {
    eligible: true,
    until: until.toISOString(),
    daysLeft: Math.max(0, Math.floor(msLeft / DAY_MS)),
  };
}

/** Customer-facing copy for why something can't come back. Kept next to the
 *  rule so a new blocked reason can't ship without a sentence for it. */
export const RETURN_BLOCKED_COPY: Record<ReturnBlockedReason, string> = {
  returns_disabled: "This store doesn't accept returns online.",
  final_sale: "This item is final sale and can't be returned.",
  window_expired: "The return window for this order has closed.",
  not_yet_delivered: "You can return this once it arrives.",
  order_not_eligible: "This order isn't eligible for a return.",
  already_returned: "This item has already been returned.",
};
