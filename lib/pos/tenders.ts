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
 * ★ `gift_card` and `store_credit` are deliberately absent even though
 * PosTenderMethod declares them: neither feature is built, so there is no
 * balance to check a tender against. Accepting one would mark a sale paid in
 * full, and let the goods leave the shelf, against money that never existed.
 *
 * The register only offers cash/card/upi — but the callers are server actions,
 * so the register's own JavaScript is not their only caller. That is exactly
 * how the `managerApproved` boolean was bypassable (§22); the lesson is that a
 * list the SERVER accepts must never be wider than what the system can
 * actually settle.
 *
 * Add them back in the same commit that builds the ledger behind them.
 */
export const TENDER_METHODS: PosTenderMethod[] = [
  "cash",
  "card",
  "upi",
  "razorpay",
];

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
): string | null {
  if (!Array.isArray(tenders) || tenders.length === 0) return emptyMessage;
  if (tenders.length > MAX_TENDERS) return "Too many payments.";
  for (const t of tenders) {
    if (!TENDER_METHODS.includes(t?.method)) {
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
      error: `A card or UPI payment can't be more than the ₹${total.toLocaleString("en-IN")} owed.`,
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
