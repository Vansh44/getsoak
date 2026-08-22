// ---------------------------------------------------------------------------
// What a collection still owes when the customer walks in.
//
// ★ `pay_at_store` IS NOT A TENDER. It is a promise, recorded at checkout, that
// the money will change hands at the counter — and the checkout screen says
// exactly that: "Pay at the counter when you collect your order." Note what it
// does NOT say. COD's copy beside it is "Pay with cash when your order arrives
// at your doorstep"; this one is deliberately silent on the instrument, because
// the customer decides when they get there and may well hand over a card.
//
// So the tender is CAPTURED at hand-over, never assumed. Assuming cash would
// put card money into the drawer's expected figure and report it SHORT — the
// exact mirror of the bug this module exists to close, and worse than it,
// because "over on cash, short on card" cannot be attributed to anything. It is
// the rule §26 and §28 already state for refunds, read the other way: the
// TENDER decides where the money goes.
//
// One definition, two callers: the queue quotes this figure and markCollected
// charges it. A screen and a charge computing the same number separately is how
// the register quoted ₹238 and rang up ₹249.90 (CODEBASE §22).
// ---------------------------------------------------------------------------

import { round2 } from "@/lib/billing/tax";

export interface CollectionPaymentState {
  paymentMethod: string | null;
  paymentStatus: string | null;
  /** The order's total. Numeric columns arrive as strings over the wire. */
  total: number | string | null;
  /**
   * What has ALREADY been taken at the counter (roadmap Step 18).
   *
   * ★★ WITHOUT THIS, PART PAYMENT IS SIMPLY WRONG. A customer who leaves a
   * ₹200 deposit on a ₹340 order and comes back tomorrow would be asked for
   * ₹340 again — the till would have taken ₹540 for a ₹340 order and the
   * drawer would report OVER by ₹200. The read lives with the callers; the
   * arithmetic stays here, so the queue and the charge cannot disagree.
   *
   * Omitted = nothing paid yet, which is every order before Step 18.
   */
  paidSoFar?: number | string | null;
}

/**
 * Rupees still owed at the counter — 0 for an order already paid online, which
 * is most of them.
 *
 * Narrow by design, and it mirrors the CASE in markCollected's claim exactly:
 * only a `pay_at_store` order still `pending` owes anything. An order whose
 * payment FAILED must not be settled by a hand-over, and one already `paid`
 * must never be charged a second time.
 */
export function amountDueAtCollection(o: CollectionPaymentState): number {
  if (o?.paymentMethod !== "pay_at_store") return 0;
  if (o.paymentStatus !== "pending") return 0;
  const total = Number(o.total);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const paid = Number(o.paidSoFar);
  // ★ A malformed or absent figure means "nothing paid", never "skip the
  // charge". Reading a bad value as paid-in-full would hand goods over free.
  const already = Number.isFinite(paid) && paid > 0 ? paid : 0;
  // ★ FLOORED AT ZERO. Over-payment is not a negative debt to be handed back
  // here — a refund is its own path (§26), and returning a negative would make
  // the tender pad ask for a negative amount.
  return round2(Math.max(0, total - already));
}
