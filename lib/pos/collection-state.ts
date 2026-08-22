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
// ★★ BUT REFUSING OUTRIGHT IS THE WRONG FIX. Someone who ordered online and
// walked in before the shop got to it is an ORDINARY collection, not an error,
// and the goods may well be packed already — the shop just hasn't tapped the
// button. Refusing puts a cashier in front of a customer, holding their order,
// unable to complete it.
//
// ★ SO THE RULE IS: POSSIBLE, DELIBERATE, RECORDED. It needs an explicit
// acknowledgement, so it is never what a mis-tap lands on, and it leaves an
// audit trail in `pickup_prepared_at`: a normal preparation records when the
// parcel was actually set aside; the confirmed unprepared hand-over writes it
// in the SAME statement as `collected_at`, so equal timestamps mean exactly
// "collected without a separate preparation step". `pickup_ready_at` cannot do
// this job because it is the checkout-time promise shown to the customer.
//
// ★★ AND IT IS NOT A PERMISSION QUESTION — deliberately, after being one for a
// day. There WAS a `fulfilment.collectUnprepared` setting whose `manager_only`
// value made a cashier fetch someone. It is gone, because `fulfil_pickup` is now
// held by every POS role (permissions.ts): a cashier told "no" here could tap
// **Mark ready** and then **Hand over** — the same outcome, two taps, no manager
// involved. A rule anyone can walk around in two taps is worse than no rule,
// because it reads as a control and is only a speed bump. What remains is the
// part that was always doing the work: making the skip DELIBERATE and VISIBLE.
// ---------------------------------------------------------------------------

/** Has someone packed this order and set it aside? */
export function isPrepared(status: string | null | undefined): boolean {
  return status === "ready";
}

export type HandoverGate =
  /** Go ahead. `unprepared` ⇒ the operator confirmed the goods are in hand. */
  { allowed: true; unprepared: boolean } | { allowed: false; reason: string };

/**
 * May this order be handed over, and does it need an acknowledgement first?
 *
 * The ONE answer, so the button on the row and the claim in the action cannot
 * disagree — the rule `collectionState` already exists to enforce, applied to
 * the preparation step.
 */
export function handoverGate(input: {
  status: string | null | undefined;
  /** Has the operator confirmed the goods are packed? Ignored when prepared. */
  acknowledged?: boolean;
}): HandoverGate {
  if (isPrepared(input.status)) return { allowed: true, unprepared: false };
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

/**
 * How far ahead the nudge goes out.
 *
 * MUST be at least TWICE the cron's own interval. The window and the schedule
 * are not in phase, so with a window of W and an interval of I the notice an
 * order actually gets is anywhere in (W − I, W]. At 24 hours against a daily
 * reaper that is (0, 24] — nothing slipped through unwarned, which is what the
 * old floor of "≥ the interval" guaranteed, but an order expiring ten minutes
 * after a run was warned ten minutes before it lapsed. A reminder nobody has
 * time to act on is the same as no reminder, and it still spends the one email
 * the claim on `pickup_warned_at` allows.
 *
 * At 48 hours against the same daily run, every order gets between 24 and 48
 * hours — a full day of notice in the worst case rather than the best.
 *
 * ⚠ Raise this if `expire-pending-payments` ever moves to a longer interval.
 *
 * ★ IT MOVED TO HOURLY (Step 15), and this number deliberately did NOT change.
 * The constraint relaxed rather than binding: at a daily interval an order was
 * warned somewhere in (24, 48] hours out, and hourly narrows that to (47, 48] —
 * the SAME promise, kept far more precisely. Lowering the window as well would
 * change what every existing merchant's customers receive, which a scheduling
 * fix has no business doing (invariant 1).
 *
 * ⚠ What hourly does NOT fix: a merchant on `fulfilment.pickupHoldDays` = 1
 * still sees the nudge land at roughly order time, because a 24h deadline is
 * already inside a 48h window the moment it is created. The honest fix is a
 * window that scales with the hold (min(48, hold/2)) rather than a constant —
 * a deliberate notification change, not a side effect of a cron edit.
 */
export const PICKUP_WARN_HOURS = 48;

/**
 * Is this collection close enough to lapsing that the counter should chase it?
 *
 * ★ THE SAME THRESHOLD THE CUSTOMER'S EMAIL USES, deliberately. The shop
 * seeing "3 expiring" while the customer was nudged on a different clock is the
 * kind of drift that makes staff distrust both. One constant, two readers.
 *
 * Already-expired is NOT "expiring soon" — that is `lapsed`/`gone`, which the
 * row already says in its own words.
 */
export function isExpiringSoon(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return false;
  return ms <= PICKUP_WARN_HOURS * 3_600_000;
}

// ---------------------------------------------------------------------------

/**
 * What the counter should SAY about this collection's money.
 *
 * ★★ "NOTHING OWED" AND "PAID" ARE NOT THE SAME FACT, and reading one as the
 * other is the trap this exists to close. `amountDueAtCollection` returns 0 for
 * an order already paid online AND for one whose online payment FAILED —
 * deliberately, because neither can be settled by a hand-over. A panel that
 * derived its headline from the figure alone would print "Paid" over a failed
 * payment, which is the one sentence that must never appear beside a parcel
 * about to be given away.
 *
 * ★ NOR CAN IT COME FROM THE PAYMENTS LIST. Online checkout writes NO
 * `order_payments` row (verified: `checkout-actions.ts` never touches that
 * table) — only the counter does. So a fully-paid online collection has an
 * EMPTY payment list, and "no payments recorded" would read as "they have paid
 * nothing" on the commonest order in the queue.
 *
 * One reader, so the badge on the row and the panel behind it cannot disagree.
 */
export type CollectionPaymentState =
  /** Nothing to take. Hand it over. */
  | "settled"
  /** A deposit is in; the rest is still owed. */
  | "part"
  /** The full amount is owed at the counter. */
  | "due"
  /** Payment failed upstream — the till cannot settle this one. */
  | "failed";

export interface CollectionPayment {
  state: CollectionPaymentState;
  /** The one line a cashier reads before deciding whether to ask for money. */
  label: string;
  paid: number;
  due: number;
}

export function collectionPayment(input: {
  paymentMethod: string | null | undefined;
  paymentStatus: string | null | undefined;
  /** Already taken AT THE COUNTER — see the note above on why this is not
   *  the same as "already paid". */
  paidSoFar: number;
  /** From `amountDueAtCollection`, never recomputed here: the queue, this
   *  panel and `markCollected` must quote one figure. */
  amountDue: number;
}): CollectionPayment {
  const paid = Number.isFinite(input.paidSoFar)
    ? Math.max(0, input.paidSoFar)
    : 0;
  const due = Number.isFinite(input.amountDue)
    ? Math.max(0, input.amountDue)
    : 0;
  const status = input.paymentStatus ?? "";

  if (due > 0) {
    return paid > 0
      ? {
          state: "part",
          label: "Part paid — the rest is due at the counter",
          paid,
          due,
        }
      : { state: "due", label: "Payment due at the counter", paid, due };
  }

  if (status === "failed") {
    return {
      state: "failed",
      label: "Payment failed — this order was never settled",
      paid,
      due: 0,
    };
  }

  if (status === "refunded" || status === "partially_refunded") {
    return {
      state: "settled",
      label: status === "refunded" ? "Refunded in full" : "Partly refunded",
      paid,
      due: 0,
    };
  }

  if (paid > 0) {
    return { state: "settled", label: "Paid at the counter", paid, due: 0 };
  }

  if (status === "paid") {
    return { state: "settled", label: "Paid online", paid, due: 0 };
  }

  // Nothing owed here, nothing recorded, not marked paid — a state the till
  // cannot explain, so it says so rather than guessing "Paid".
  return {
    state: "settled",
    label: "Nothing to collect at the counter",
    paid,
    due: 0,
  };
}
