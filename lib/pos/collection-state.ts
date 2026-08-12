// What a counter may still do with a collection — the ONE answer, so the button
// on the row and the claim in the action cannot disagree.
//
// ★ THE PROBLEM THIS FIXES. `markCollected` scopes its read to
// `pickup_status in ('awaiting','ready')`, so an expired or already-collected
// order can never be handed over — the server has always been right. The COUNTER
// did not know: `findPickupByCode` has no status filter (deliberately — see
// below), and the row's "Hand over" button was drawn unconditionally. So
// scanning a cancelled order's code produced a full-strength green button that
// always failed, in front of the customer. That is the exact anti-pattern the
// discount fields and the BORIS cash button already exist to avoid: a control
// that always fails at the till is worse than no control.
//
// ★ AND WHY THE LOOKUP STILL RETURNS EXPIRED ORDERS. Filtering them out would
// swap a failing button for "No collection found for that code" — which is a
// lie, and leaves a customer standing at a counter with an order the shop can
// see and cannot explain. The row renders; it just says what happened instead
// of offering an action.
//
// Pure and dependency-free: the client component imports it, and
// lib/fulfilment/pickup.ts (which owns the sweep) pulls in the db client, so it
// cannot be the home for this. Same split as lib/logs/failure-types.ts.

/** Statuses a collection can be handed over from — mirrors `markCollected`'s
 *  claim, and `getPickupQueue`'s filter. */
const LIVE_STATUSES = new Set(["awaiting", "ready"]);

export type CollectionState =
  /** Waiting, inside its hold window. Hand it over. */
  | "collectable"
  /**
   * Waiting, but the hold window has passed and the sweep has not run yet.
   *
   * ★ STILL COLLECTABLE, AND THAT IS DELIBERATE. `sweepExpiredPickups` runs
   * daily, so this state lasts up to 24 hours in production — and during it the
   * server will happily hand the order over, because the customer turning up a
   * few hours late should simply be served. The row needs to SAY so: showing
   * "Expired" beside a green button, with nothing explaining which one to
   * believe, is what made this state look like a bug.
   */
  | "lapsed"
  /** Cancelled, expired-and-swept, or already handed over. Nothing to do. */
  | "gone";

export function collectionState(
  status: string | null | undefined,
  expiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): CollectionState {
  if (!status || !LIVE_STATUSES.has(status)) return "gone";
  if (!expiresAt) return "collectable";
  const ms = new Date(expiresAt).getTime();
  // An unparseable date must not strand a collectable order — the hold is a
  // courtesy, the goods are on the shelf, and refusing here helps nobody.
  if (!Number.isFinite(ms)) return "collectable";
  return ms < now.getTime() ? "lapsed" : "collectable";
}

/** True when the counter may still hand this order over. */
export function isCollectable(state: CollectionState): boolean {
  return state !== "gone";
}

/**
 * What to tell the cashier, in words they can read out to the customer.
 *
 * Returns "" for the ordinary case — a note on every row is a note nobody
 * reads. Only the two states that need explaining get one.
 */
export function collectionNote(
  state: CollectionState,
  status: string | null | undefined,
): string {
  if (state === "collectable") return "";
  if (state === "lapsed") {
    return "The hold period has passed, but this can still be handed over.";
  }
  if (status === "collected") return "Already handed over.";
  if (status === "expired") {
    // Says what happened to the STOCK too: it is the question a merchant asks
    // next, and the answer is not obvious from "cancelled".
    return "Not collected in time — this order was cancelled and the stock went back on the shelf.";
  }
  if (status === "cancelled") return "This order was cancelled.";
  return "This order is no longer waiting for collection.";
}
