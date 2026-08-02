// What a refund is allowed to be (roadmap Step 2, docs/returns-exchanges-plan.md §3).
//
// Pure: no DB, no gateway, no request. This is money leaving, so the rules that
// decide how much are arithmetic that can be tested rather than behaviour you
// have to reproduce against a live Razorpay account.
//
// ── Paise, not rupees ──────────────────────────────────────────────────────
// The same reason lib/pos/returns.ts works in paise: summing rupee floats
// leaves a stray fraction, and here that fraction decides whether a full
// refund is allowed at all ("₹840.00 exceeds the refundable ₹839.99999").

/** Where a refund is in its life. Mirrors the CHECK in pos_12_returns.sql. */
export const REFUND_STATUSES = ["pending", "completed", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * How the money goes back.
 *
 * `razorpay` is the only one that moves money by itself. `manual` records
 * money the merchant moved outside the platform — a UPI transfer from their
 * own phone to a COD customer — which is the honest v1 answer for COD (§3.3)
 * and what Shopify does for its manual payment methods too.
 *
 * `cash` / `card` / `upi` are the at-the-counter tenders pos-return-actions
 * already writes; they are listed so this type covers every row in the table,
 * NOT so the dashboard offers them. `store_credit` lands with roadmap Step 4.
 */
export const REFUND_METHODS = [
  "razorpay",
  "manual",
  "cash",
  "card",
  "upi",
] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** Methods the dashboard may CHOOSE. A gateway refund is decided by the
 *  tender, never offered as a preference — see §3.1: handing cash back for a
 *  card sale is the card-not-present laundering path. */
export const DASHBOARD_REFUND_METHODS = ["razorpay", "manual"] as const;

export const toPaise = (n: number) => Math.round((Number(n) || 0) * 100);
export const toRupees = (p: number) => Math.round(p) / 100;

/** One already-recorded refund, as stored. */
export interface ExistingRefund {
  amount: number;
  status: string;
}

/**
 * How much of an order can still go back.
 *
 * ★ A `pending` refund counts against the cap. It has not settled, but it
 * might — excluding it lets a second refund be raised for the same money
 * while the first is still in flight, and the two together over-refund the
 * order. Only a `failed` refund frees its amount again.
 */
export function refundableAmount(input: {
  orderTotal: number;
  refunds: ExistingRefund[];
}): number {
  const totalP = Math.max(0, toPaise(input.orderTotal));
  const spentP = input.refunds
    .filter((r) => r.status !== "failed")
    .reduce((sum, r) => sum + Math.max(0, toPaise(r.amount)), 0);
  return toRupees(Math.max(0, totalP - spentP));
}

export type AmountCheck = { amount: number } | { error: string };

/**
 * Validate a requested refund against what remains.
 *
 * An omitted amount means "all of it" — the overwhelmingly common case, and
 * one the caller should not have to compute (computing it client-side is how
 * a rounding difference becomes a refused refund).
 */
export function checkRefundAmount(
  requested: number | undefined,
  refundable: number,
): AmountCheck {
  const capP = toPaise(refundable);
  if (capP <= 0)
    return { error: "This order has already been fully refunded." };

  if (requested === undefined || requested === null) {
    return { amount: toRupees(capP) };
  }
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return { error: "Enter a valid refund amount." };
  }
  const wantP = toPaise(requested);
  if (wantP <= 0) return { error: "Refund amount must be more than zero." };
  if (wantP > capP) {
    return {
      error: `You can refund at most ₹${toRupees(capP).toFixed(2)} on this order.`,
    };
  }
  return { amount: toRupees(wantP) };
}

/** Razorpay's refund states → ours. An unknown state is treated as still in
 *  flight, never as settled: the sweep will ask again, whereas guessing
 *  "completed" would close a refund that may yet fail. */
export function mapGatewayRefundStatus(rzpStatus: string): RefundStatus {
  switch (rzpStatus) {
    case "processed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Find OUR refund in the gateway's list for a payment.
 *
 * Matched on the key we planted in `notes.sm_refund_key`, never on amount:
 * two legitimate ₹500 refunds against one order are indistinguishable by
 * amount, and picking the wrong one marks the wrong row settled.
 */
export function matchGatewayRefund<
  T extends { notes?: Record<string, string> | null },
>(refunds: T[], idempotencyKey: string): T | null {
  if (!idempotencyKey) return null;
  return refunds.find((r) => r.notes?.sm_refund_key === idempotencyKey) ?? null;
}
