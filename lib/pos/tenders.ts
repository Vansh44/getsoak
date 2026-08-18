// ---------------------------------------------------------------------------
// What the till may be paid with, and whether a given payment settles a total.
//
// Extracted from pos-sale-actions.ts when the collection counter became a
// second place money is taken (CODEBASE §23). The allowlist below is a SECURITY
// boundary, not a UI list — a second hand-written copy of it is how a tender
// the system cannot settle gets accepted at the one counter nobody audited,
// the same reasoning that put the refund mechanism in one place
// (lib/payments/issue-refund.ts).
//
// It lives here rather than in pos-sale-actions.ts because that is a
// "use server" file: everything exported from one is a public endpoint, and
// only async functions may be exported at all. The TYPES are re-exported from
// there so existing importers are unchanged.
// ---------------------------------------------------------------------------

import { changeDue, coversTotal } from "@/lib/pos/totals";

export type PosTenderMethod =
  | "cash"
  | "card"
  | "upi"
  | "gift_card"
  | "store_credit"
  | "razorpay";

export interface PosTender {
  method: PosTenderMethod;
  amount: number;
  /** Cash handed over — change is derived, never trusted from the client. */
  tendered?: number;
  reference?: string;
}

/** More than this on one order is a stuck button, not a split payment. */
export const MAX_TENDERS = 6;

/**
 * What the till may actually be paid with TODAY.
 *
 * ★ `gift_card` IS STILL ABSENT, and for the original reason: no ledger stands
 * behind it, so accepting one would mark a sale paid in full — and let the
 * goods leave the shelf — against money that never existed. A list the SERVER
 * accepts must never be wider than what the system can actually settle, because
 * these are server actions and the register's own JavaScript is not their only
 * caller (that is exactly how the `managerApproved` boolean was bypassable).
 *
 * ★★ `store_credit` IS NOW HERE, because the ledger finally is (§29): a real
 * balance, an append-only history, and `try_spend_customer_credit` — a single
 * conditional UPDATE, so two tills cannot overdraw the same balance. It was the
 * one genuinely inconsistent hole in the till: a shop could refund a customer
 * to credit across the counter and then refuse that credit at the same counter.
 *
 * ⚠ Being on this list is NOT the whole gate. `placePosSale` additionally
 * requires an ATTACHED CUSTOMER (a balance belongs to somebody) and SPENDS the
 * credit through the RPC before the sale completes. This list says "the shape
 * is settleable"; the action proves the money exists.
 */
export const TENDER_METHODS: PosTenderMethod[] = [
  "cash",
  "card",
  "upi",
  "razorpay",
  "store_credit",
];

/**
 * ★★ WHAT A COLLECTION COUNTER MAY TAKE — STILL NARROWER, AND THAT IS THE POINT.
 *
 * `markCollected` settles a pay-at-store collection. Because it shares
 * `validateTenderShape`, adding a method here makes that counter accept it —
 * so a method belongs on this list only once that action can actually SETTLE
 * it. Widening a shared constant without checking both sides is the exact
 * failure the allowlist exists to prevent; a test caught it for `store_credit`.
 *
 * ★★ `razorpay` LEFT THIS LIST IN STEP 12 AND HAS REJOINED IT. It was removed
 * while only `placePosSale` verified gateway payments — accepting it here would
 * have marked a collection paid against money nobody checked was taken.
 * `markCollected` now runs the SAME `verifyGatewayTenders` from
 * lib/payments/pos-gateway.ts, before its claim, so the reason for the
 * exclusion is gone.
 *
 * ★ `store_credit` IS STILL ABSENT, and for its original reason: no credit
 * spend is wired into `markCollected`, so accepting one would mark an order
 * paid against a balance nothing ever deducted. Wire that in and the two lists
 * finally become one.
 */
export const COUNTER_TENDER_METHODS: PosTenderMethod[] = [
  "cash",
  "card",
  "upi",
  "razorpay",
];

/** Tenders that need a customer on the sale, because they draw on a balance
 *  that belongs to one. Checked in the action, listed here so there is one
 *  place to add the next such method. */
export const ACCOUNT_TENDERS: PosTenderMethod[] = ["store_credit"];

export function isAccountTender(method: PosTenderMethod): boolean {
  return ACCOUNT_TENDERS.includes(method);
}

/** How much of a sale is being settled from an account balance. */
export function accountTenderTotal(
  tenders: PosTender[],
  method: PosTenderMethod,
): number {
  return tenders
    .filter((t) => t.method === method)
    .reduce((sum, t) => sum + (t.amount || 0), 0);
}

/**
 * Shape validation, before any DB work. Returns an error message, or null when
 * the tenders are structurally usable.
 *
 * `emptyMessage` differs by counter — "complete the sale" is wrong wording at a
 * collection, where the goods were bought weeks ago — so it is the caller's.
 */
export function validateTenderShape(
  tenders: PosTender[],
  emptyMessage: string,
  /** Defaults to the SELL counter's set. A caller that cannot settle every
   *  method — see COUNTER_TENDER_METHODS — passes its own. */
  allowed: PosTenderMethod[] = TENDER_METHODS,
): string | null {
  if (!Array.isArray(tenders) || tenders.length === 0) return emptyMessage;
  if (tenders.length > MAX_TENDERS) return "Too many payments.";
  for (const t of tenders) {
    if (!allowed.includes(t?.method)) {
      return "Invalid payment method.";
    }
    if (!Number.isFinite(t.amount) || t.amount <= 0) {
      return "Invalid payment amount.";
    }
  }
  return null;
}

export type TenderSettlement =
  | { error: string }
  | { paid: number; change: number };

/**
 * Does what the customer handed over settle `total`, and what comes back?
 *
 * Compared in PAISE by `coversTotal` — a rupee-float compare can refuse an
 * exactly-covering payment. Change is derived here and never taken from the
 * client, and it can only come out of a cash tender: a card cannot be
 * overpaid, so change against one is a data-entry error that would leave the
 * drawer short by the difference.
 */
export function settleTenders(
  tenders: PosTender[],
  total: number,
): TenderSettlement {
  const paid = tenders.reduce((s, t) => s + (t.amount || 0), 0);
  if (!coversTotal(paid, total)) {
    return {
      error: `The payment doesn't cover the total of ₹${total.toLocaleString("en-IN")}.`,
    };
  }

  // ★★ A NON-CASH TENDER MAY NEVER EXCEED THE TOTAL. Cash is the only
  // instrument that can be over-handed, because it is the only one the customer
  // physically hands over in fixed denominations — a card or a UPI transfer is
  // charged for an amount somebody TYPED, so an amount above the total is
  // either a slip or a way to take money out of the drawer.
  //
  // ⚠ This used to be guarded only by "change requires a cash tender", which
  // reads as the same rule and is not: adding a ₹1 cash tender satisfied it, so
  // `card ₹100,000 + cash ₹50` on a ₹100 sale was ACCEPTED and returned ₹99,950
  // of change. That is the card-cash-out fraud in one screen — the drawer really
  // is down ₹99,950, the books say a ₹100,000 card payment arrived, and shift
  // reconciliation BALANCES, because expected cash was computed from the same
  // bad tender. Nothing downstream would ever have flagged it.
  const nonCash = tenders
    .filter((t) => t.method !== "cash")
    .reduce((s, t) => s + (t.amount || 0), 0);
  if (nonCash > 0 && changeDue(nonCash, total) > 0) {
    return {
      // Store credit is non-cash too, and over-applying it would hand real
      // change out of the drawer against a balance — turning credit into a
      // cash withdrawal.
      error: `A card, UPI or store-credit payment can't be more than the ₹${total.toLocaleString("en-IN")} owed.`,
    };
  }

  const change = changeDue(paid, total);
  // ⚠ UNREACHABLE BY CONSTRUCTION while the rule above holds — with no cash
  // tender, `paid` IS `nonCash`, which has just been bounded by `total`, so
  // there is no change to give. Kept as a backstop for the day somebody relaxes
  // the rule above, and pinned by a test that asserts the message a cashier now
  // gets instead. Do not read its presence as evidence the case can happen.
  if (change > 0 && !tenders.some((t) => t.method === "cash")) {
    return { error: "Only a cash payment can produce change." };
  }
  return { paid, change };
}
