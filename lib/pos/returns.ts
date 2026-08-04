// What a return is worth (roadmap Phase G / POS 5).
//
// Pure: no DB, no operator, no request. Everything here is arithmetic on a
// sale's stored snapshot, which is what makes it testable — and this is money
// leaving the drawer, so it had better be.
//
// ── The trap this module exists to avoid ───────────────────────────────────
// `order_items.total` is net of that line's OWN markdown but GROSS of the
// order-level discount, while `order_items.tax_amount` already had the order
// discount allocated into it (lib/billing/tax.ts allocates proportionally
// before taxing). Refund `total + tax_amount` and you hand back that line's
// share of the order discount as well — silently, on every discounted sale.
//
// So the order discount has to be re-allocated the same way it was allocated
// when the sale was rung, and subtracted.
//
// ── Paise, not rupees ──────────────────────────────────────────────────────
// Every intermediate is an integer number of paise. Allocating a discount
// across lines in floats leaves a stray fraction that turns a full return into
// "₹0.01 less than they paid" — the kind of difference a customer notices at a
// counter and nobody can explain.

/** One line of the original sale, as stored. */
export interface ReturnableLine {
  /** order_items.id */
  id: string;
  quantity: number;
  /** order_items.total — net of this line's markdown, gross of order discount. */
  lineTotal: number;
  /** order_items.tax_amount — already net of the allocated order discount. */
  taxAmount: number;
  /** How many units have been returned on earlier returns. */
  alreadyReturned?: number;
}

export interface RefundLine {
  id: string;
  quantity: number;
  /** Goods value refunded for this line, excluding tax. */
  amount: number;
  tax: number;
  /** amount + tax — what actually goes back for this line. */
  total: number;
}

export interface RefundBreakdown {
  lines: RefundLine[];
  amount: number;
  tax: number;
  total: number;
}

const toPaise = (n: number) => Math.round((Number(n) || 0) * 100);
const toRupees = (p: number) => Math.round(p) / 100;

/**
 * Units originally sold on a line, floored at zero.
 *
 * One definition, used by both `remainingQty` and the per-unit maths below.
 * It was written out twice, and the second copy's `|| 0` was provably dead:
 * reaching it requires `remainingQty(line) > 0`, which already proves the
 * quantity is a truthy integer ≥ 1. Dead code that LOOKS defensive is worse
 * than none — it invites the reader to assume a case is handled.
 */
function soldQty(line: ReturnableLine): number {
  return Math.max(0, Math.trunc(line.quantity || 0));
}

/** Units still returnable on a line. Never negative, never above what sold. */
export function remainingQty(line: ReturnableLine): number {
  const done = Math.max(0, Math.trunc(line.alreadyReturned || 0));
  return Math.max(0, soldQty(line) - done);
}

/**
 * What to hand back for a requested set of lines and quantities.
 *
 * `orderDiscount` is the ORDER-level discount only — recover it as
 * `orders.discount − Σ order_items.line_discount`, because the stored
 * `orders.discount` includes both and the line markdowns are already inside
 * `lineTotal`.
 *
 * A request for more than remains is clamped rather than rejected: the caller
 * validates and reports, and this function's job is to never produce a number
 * bigger than the sale.
 */
export function refundBreakdown(input: {
  lines: ReturnableLine[];
  orderDiscount?: number;
  request: { id: string; quantity: number }[];
}): RefundBreakdown {
  const { lines, request } = input;

  // Allocate the order discount across lines exactly as the sale did:
  // proportionally to each line's amount, in paise, with the remainder given
  // to the largest lines so the parts sum to the whole.
  const grossPaise = lines.map((l) => toPaise(l.lineTotal));
  const grossTotal = grossPaise.reduce((a, b) => a + b, 0);
  const discountPaise = Math.min(
    Math.max(0, toPaise(input.orderDiscount ?? 0)),
    grossTotal,
  );

  const share = new Array<number>(lines.length).fill(0);
  if (discountPaise > 0 && grossTotal > 0) {
    let handed = 0;
    const exact = grossPaise.map((g) => (g * discountPaise) / grossTotal);
    exact.forEach((e, i) => {
      share[i] = Math.floor(e);
      handed += share[i];
    });
    // Largest fractional parts absorb the remainder — otherwise the last line
    // silently carries everyone's rounding.
    const order = exact
      .map((e, i) => ({ i, frac: e - Math.floor(e) }))
      .sort((a, b) => b.frac - a.frac);
    let left = discountPaise - handed;
    for (const { i } of order) {
      if (left <= 0) break;
      share[i] += 1;
      left -= 1;
    }
  }

  const byId = new Map(lines.map((l, i) => [l.id, i]));
  const out: RefundLine[] = [];
  let amountP = 0;
  let taxP = 0;

  // ★ COALESCE BEFORE CLAMPING, or the cap is per-ENTRY instead of per-LINE.
  //
  // The request array comes from a client. Clamping each entry against
  // `remainingQty` independently means [{A,1},{A,1},{A,1}] on a one-unit line
  // passes three times — each entry is individually "within what remains" — and
  // returns 3× the money for one unit, in a single call, with no race needed.
  // Both callers are exposed: the till's cash refund (pos-return-actions) and
  // the shopper's request (return-actions). Summing first makes the clamp mean
  // what it reads as.
  const wanted = new Map<string, number>();
  for (const req of request) {
    if (!byId.has(req.id)) continue;
    const q = Math.max(0, Math.trunc(Number(req.quantity) || 0));
    if (q <= 0) continue;
    wanted.set(req.id, (wanted.get(req.id) ?? 0) + q);
  }

  for (const [id, asked] of wanted) {
    const i = byId.get(id)!;
    const line = lines[i];
    const max = remainingQty(line);
    const qty = Math.min(asked, max);
    if (qty <= 0) continue;

    // At least 1 as a divisor guard; remainingQty above has already proved
    // it is, so this can only ever be the sold quantity itself.
    const sold = Math.max(1, soldQty(line));
    // Net of this line's share of the order discount — the number the customer
    // actually paid for these goods.
    const netP = grossPaise[i] - share[i];
    const lineAmountP = Math.round((netP * qty) / sold);
    const lineTaxP = Math.round((toPaise(line.taxAmount) * qty) / sold);

    amountP += lineAmountP;
    taxP += lineTaxP;
    out.push({
      id: line.id,
      quantity: qty,
      amount: toRupees(lineAmountP),
      tax: toRupees(lineTaxP),
      total: toRupees(lineAmountP + lineTaxP),
    });
  }

  return {
    lines: out,
    amount: toRupees(amountP),
    tax: toRupees(taxP),
    total: toRupees(amountP + taxP),
  };
}

/** Every remaining unit — "refund the whole thing". */
export function fullReturnRequest(
  lines: ReturnableLine[],
): { id: string; quantity: number }[] {
  return lines
    .map((l) => ({ id: l.id, quantity: remainingQty(l) }))
    .filter((r) => r.quantity > 0);
}
