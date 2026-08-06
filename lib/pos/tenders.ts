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
  const change = changeDue(paid, total);
  if (change > 0 && !tenders.some((t) => t.method === "cash")) {
    return { error: "Only a cash payment can produce change." };
  }
  return { paid, change };
}
