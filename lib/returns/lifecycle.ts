// Where a return is in its life (returns_02_requests.sql).
//
// PURE, and in its own module because THREE callers have to agree on one
// question — "does this return still hold the units it names?" — and they are
// in different layers: the shopper's request form, the merchant's queue, and
// the till.
//
// ★ THE ANSWER IS "ONLY THE OPEN ONES".
//
// A rejected or withdrawn request must give its quantities back, or one
// decline makes those items unreturnable forever — the exact opposite of what
// declining means. The till learned this the hard way: `getReturnableSale` was
// written when every `order_returns` row was a finished counter return, so it
// counted rows with NO status filter at all. Once Step 3 introduced the
// lifecycle, a customer whose online return had been REJECTED could no longer
// bring the goods to the counter either — the till still counted the dead
// request against them.

/** Every status the CHECK constraint allows. */
export const RETURN_STATUSES = [
  "requested",
  "approved",
  "received",
  "completed",
  "rejected",
  "cancelled",
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/**
 * Statuses that still hold units.
 *
 * A line already inside one of these can't be requested again — anywhere.
 * `rejected` and `cancelled` are deliberately absent: they free what they held.
 */
export const OPEN_RETURN_STATUSES: ReturnStatus[] = [
  "requested",
  "approved",
  "received",
  "completed",
];

/** Statuses a queue filter may ask for. */
export const FILTERABLE_RETURN_STATUSES: readonly string[] = RETURN_STATUSES;
