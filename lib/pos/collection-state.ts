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

// ---------------------------------------------------------------------------
// Handing over something nobody prepared
//
// ★ THE BUG THIS ANSWERS. `markCollected` accepted BOTH 'awaiting' and 'ready',
// and the row drew one green "Hand over" for either — so a cashier could close
// an order out of the "To prepare" queue that nobody had packed, in one tap,
// silently. The two sections of that queue exist to separate work the SHOP owes
// from parcels waiting on a CUSTOMER, and this let the first vanish without
// being done.
//
// ★★ BUT REFUSING OUTRIGHT IS THE WRONG FIX, and it is worth being precise
// about why. Marking ready is `fulfil_pickup` (manager+), so a hard gate leaves
// a cashier alone at the counter, with the customer in front of them, unable to
// serve an order the shop can see — and the goods may well be packed already.
// Someone who ordered online and walked in before the shop got to it is an
// ORDINARY collection, not an error.
//
// ★ SO THE RULE IS: POSSIBLE, DELIBERATE, RECORDED. "Mark ready" conflates two
// acts — *the goods are packed* (a physical fact) and *tell the customer to
// travel* (a promise, and the reason the manager gate exists). When the customer
// is already at the counter the second is moot, and the person holding the box
// is the best witness there is to the first. So a hand-over from 'awaiting'
// needs an explicit acknowledgement rather than a manager, and it is never what
// a mis-tap lands on. It leaves its own audit trail with no new column:
// `pickup_ready_at` and `collected_at` are written by the SAME statement, so
// `pickup_ready_at = collected_at` means exactly "collected without being
// prepared".
// ---------------------------------------------------------------------------

/** Who may hand over an order that was never marked ready (`fulfilment.collectUnprepared`). */
export type UnpreparedPolicy = "anyone" | "manager_only";

/** Anything the merchant has not chosen resolves to today's behaviour. */
export function normalizeUnpreparedPolicy(v: unknown): UnpreparedPolicy {
  return v === "manager_only" ? "manager_only" : "anyone";
}

/** Has someone packed this order and set it aside? */
export function isPrepared(status: string | null | undefined): boolean {
  return status === "ready";
}

export type HandoverGate =
  /** Go ahead. `unprepared` ⇒ the cashier must confirm the goods are in hand. */
  { allowed: true; unprepared: boolean } | { allowed: false; reason: string };

/**
 * May this operator hand this order over, and does it need an acknowledgement?
 *
 * The ONE answer, so the button on the row and the claim in the action cannot
 * disagree — the rule `collectionState` already exists to enforce, applied to
 * the preparation step.
 */
export function handoverGate(input: {
  status: string | null | undefined;
  /** Does the operator hold `fulfil_pickup`? */
  canFulfilPickup: boolean;
  policy: UnpreparedPolicy;
  /** Has the cashier confirmed the goods are packed? Ignored when prepared. */
  acknowledged?: boolean;
}): HandoverGate {
  if (isPrepared(input.status)) return { allowed: true, unprepared: false };

  if (input.policy === "manager_only" && !input.canFulfilPickup) {
    return {
      allowed: false,
      reason:
        "This order hasn't been marked ready. Ask a manager to check it off before handing it over.",
    };
  }
  if (!input.acknowledged) {
    return {
      allowed: false,
      reason:
        "This order hasn't been marked ready. Confirm the goods are packed before handing them over.",
    };
  }
  return { allowed: true, unprepared: true };
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
