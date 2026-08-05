// POS Phase 3 — cash-drawer arithmetic. PURE, so the one number a merchant
// will argue about (the variance) is testable without a database.
//
// The whole point of a shift is this equation:
//
//   expected = opening float
//            + net cash taken in sales
//            + cash paid IN  (float top-up, a refunded supplier payment)
//            − cash paid OUT (payouts)
//            − cash dropped to the safe
//
//   variance = counted − expected
//
// Negative variance means the drawer is SHORT. That is the number that
// distinguishes a skimming problem from a miscounting one, so it must never be
// quietly wrong.

export type CashMovementType = "drop" | "payout" | "paid_in";

/** One cash tender row from `order_payments`, joined to its order. */
export interface CashPaymentRow {
  orderId: string;
  /** What the customer handed over. */
  amount: number;
  /** Change given back — a property of the ORDER, replicated onto each of its
   *  cash rows by placePosSale. See netCashFromSales for why that matters. */
  changeDue: number | null;
}

export interface MovementRow {
  type: CashMovementType;
  amount: number;
}

/** Money is rounded to paise at every boundary so float drift can't accumulate
 *  across a day of sales and surface as a phantom one-rupee variance. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Net cash the drawer actually gained from sales: handed over, less change
 * given back.
 *
 * The grouping is load-bearing. `placePosSale` computes change once per SALE
 * and writes it onto EVERY cash tender row of that order, so a sale settled
 * with two cash tenders carries the same change twice. Summing `change_due`
 * across rows would subtract it twice and report the drawer short by that
 * amount every time — which is exactly the kind of small, consistent
 * discrepancy that gets blamed on a cashier.
 */
export function netCashFromSales(rows: CashPaymentRow[]): number {
  const byOrder = new Map<string, { taken: number; change: number }>();
  for (const r of rows) {
    const cur = byOrder.get(r.orderId) ?? { taken: 0, change: 0 };
    cur.taken += r.amount || 0;
    // Max, not sum — the same change repeated on sibling rows is one refund of
    // change, not several.
    cur.change = Math.max(cur.change, r.changeDue ?? 0);
    byOrder.set(r.orderId, cur);
  }
  let net = 0;
  for (const o of byOrder.values()) net += o.taken - o.change;
  return round2(net);
}

export interface ShiftTotals {
  openingFloat: number;
  /** Net cash from sales (already less change given). */
  cashSales: number;
  paidIn: number;
  payouts: number;
  drops: number;
  /** Cash handed back on returns — money OUT of this drawer. */
  cashRefunds: number;
  /** What the drawer SHOULD hold right now. */
  expectedCash: number;
}

export function shiftTotals(input: {
  openingFloat: number;
  payments: CashPaymentRow[];
  movements: MovementRow[];
  /** Cash refunds paid out of this drawer (pos_12). Omitted = none, so a
   *  store with no returns behaves exactly as before. */
  cashRefunds?: number;
}): ShiftTotals {
  const openingFloat = round2(input.openingFloat || 0);
  const cashSales = netCashFromSales(input.payments);

  let paidIn = 0;
  let payouts = 0;
  let drops = 0;
  for (const m of input.movements) {
    // Amounts are stored positive and the type carries direction (see the
    // migration) — a signed amount AND a type is two sources of truth.
    const amt = Math.abs(m.amount || 0);
    if (m.type === "paid_in") paidIn += amt;
    else if (m.type === "payout") payouts += amt;
    else if (m.type === "drop") drops += amt;
  }

  // ★ A cash refund leaves the drawer. Without this the count comes up SHORT
  // by exactly the refunds taken that day — and a short drawer gets blamed on
  // a cashier, which is the same failure the double-counted change caused.
  const cashRefunds = round2(Math.abs(input.cashRefunds || 0));

  return {
    openingFloat,
    cashSales,
    paidIn: round2(paidIn),
    payouts: round2(payouts),
    drops: round2(drops),
    cashRefunds,
    expectedCash: round2(
      openingFloat + cashSales + paidIn - payouts - drops - cashRefunds,
    ),
  };
}

/** counted − expected. Negative means the drawer is short. */
export function varianceOf(counted: number, expected: number): number {
  return round2((counted || 0) - (expected || 0));
}

export type VarianceState = "balanced" | "over" | "short";

/**
 * A drawer counted to the paise is a fiction — notes and coins are counted by
 * hand. `tolerance` lets a store treat trivial differences as balanced; the
 * default of 0 reports the truth and lets the UI decide how loudly to say it.
 */
export function varianceState(variance: number, tolerance = 0): VarianceState {
  if (Math.abs(variance) <= Math.abs(tolerance)) return "balanced";
  return variance > 0 ? "over" : "short";
}

/**
 * Takings per payment method, for the Z-report's breakdown.
 *
 * Cash delegates to netCashFromSales rather than subtracting `changeDue`
 * inline, so it inherits the per-order grouping — otherwise this would
 * double-subtract change on a split cash payment in exactly the way that
 * function exists to prevent. Everything else is face value: you cannot give
 * change against a card.
 */
export function totalsByMethod(
  rows: Array<{
    orderId: string;
    method: string;
    amount: number;
    changeDue: number | null;
  }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const cash: CashPaymentRow[] = [];
  for (const r of rows) {
    if (r.method === "cash") {
      cash.push({
        orderId: r.orderId,
        amount: r.amount,
        changeDue: r.changeDue,
      });
      continue;
    }
    out[r.method] = round2((out[r.method] ?? 0) + (r.amount || 0));
  }
  if (cash.length > 0) out.cash = netCashFromSales(cash);
  return out;
}
