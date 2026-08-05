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
 * NOT so the dashboard offers them.
 *
 * `store_credit` moves no money at all — it hands the customer a balance to
 * spend here. It is the honest answer for COD, where nothing was captured and
 * there is no instrument to reverse. Always OFFERED, never forced (§3.3).
 */
export const REFUND_METHODS = [
  "razorpay",
  "manual",
  "cash",
  "card",
  "upi",
  /** Settled as a balance the customer can spend here. No money leaves. */
  "store_credit",
] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** Methods the dashboard may CHOOSE. A gateway refund is decided by the
 *  tender, never offered as a preference — see §3.1: handing cash back for a
 *  card sale is the card-not-present laundering path. */
export const DASHBOARD_REFUND_METHODS = [
  "razorpay",
  "manual",
  "store_credit",
] as const;

export const toPaise = (n: number) => Math.round((Number(n) || 0) * 100);
export const toRupees = (p: number) => Math.round(p) / 100;

/** One already-recorded refund, as stored. */
export interface ExistingRefund {
  amount: number;
  status: string;
  /** Absent on older callers; only the money-cap below reads it. */
  method?: string | null;
}

/**
 * How much of an order can still go back.
 *
 * ★ A `pending` refund counts against the cap. It has not settled, but it
 * might — excluding it lets a second refund be raised for the same money
 * while the first is still in flight, and the two together over-refund the
 * order. Only a `failed` refund frees its amount again.
 *
 * ★ A MONEY REFUND CANNOT EXCEED WHAT MONEY PAID.
 *
 * `orders.total` is the full value of the GOODS and stays that way even when
 * part of it was settled with store credit — credit is a payment, not a
 * discount (§29), so netting it off would understate the sale on the invoice
 * and compute GST on the wrong base. The consequence is that `total` is NOT
 * what any real instrument received: a ₹500 order paid with ₹200 credit and
 * ₹300 on a card only ever charged ₹300.
 *
 * Capping every method at `total` therefore hands ₹200 of the store's own
 * money back on a refund it never took. Razorpay would refuse it (a refund
 * above the payment), but `cash` and `manual` have no such backstop — the
 * merchant simply counts out too much. So a money refund is additionally
 * capped at what money paid, less what money has already gone back.
 *
 * Refunding AS CREDIT is uncapped by this rule: giving back a balance for a
 * balance costs the store nothing it didn't already owe.
 *
 * Both new inputs are optional and default to the old behaviour, so a caller
 * that doesn't know about store credit is unaffected.
 */
export function refundableAmount(input: {
  orderTotal: number;
  refunds: ExistingRefund[];
  /** `orders.store_credit_used` — the part of the total no instrument paid. */
  storeCreditUsed?: number;
  /** Where this refund would go. Omit for the overall cap. */
  method?: RefundMethod | null;
}): number {
  const totalP = Math.max(0, toPaise(input.orderTotal));
  const live = input.refunds.filter((r) => r.status !== "failed");
  const spentP = live.reduce(
    (sum, r) => sum + Math.max(0, toPaise(r.amount)),
    0,
  );
  const overallP = Math.max(0, totalP - spentP);

  if (!input.method || input.method === "store_credit") {
    return toRupees(overallP);
  }

  const creditP = Math.max(0, toPaise(input.storeCreditUsed ?? 0));
  if (creditP <= 0) return toRupees(overallP);

  const moneyPaidP = Math.max(0, totalP - creditP);
  const moneyBackP = live
    .filter((r) => r.method !== "store_credit")
    .reduce((sum, r) => sum + Math.max(0, toPaise(r.amount)), 0);

  return toRupees(Math.max(0, Math.min(overallP, moneyPaidP - moneyBackP)));
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
