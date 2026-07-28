// ---------------------------------------------------------------------------
// The register's money math — pure, so the SCREEN and the SALE agree.
//
// The cashier reads a number off the till and takes cash against it. Until
// 2026-07-27 that number was the PRE-TAX subtotal ("Tax is calculated on the
// server when the sale completes"), while placePosSale charged the tax-inclusive
// total. A ₹238 cart on a 5% class was quoted as ₹238, rung up at ₹249.90, and
// ₹300 tendered came back as ₹50.10 change instead of the ₹62 the customer was
// promised — the till reconciles, the customer is short-changed, and the cashier
// cannot tell which number to believe. Worse, taking exactly the quoted ₹238 was
// rejected as "the payment doesn't cover the total" while the same panel said
// "Paid in full ₹238".
//
// So the total is computed HERE and nowhere else: placePosSale calls it to
// charge, and the sell screen calls it to quote. The server stays authoritative
// (it re-reads prices and rates from the DB), but it can no longer disagree with
// the screen about the arithmetic, because there is only one implementation.
//
// Rounding note: money is compared in PAISE (integers). Comparing rupee floats
// is how a ₹0.005 rounding difference becomes a refused payment.
// ---------------------------------------------------------------------------

import { computeTax, round2, type TaxLineResult } from "@/lib/billing/tax";

export interface PosTotalsLine {
  /** unit price × quantity, BEFORE this line's own markdown. */
  gross: number;
  /** Per-line markdown (a damaged tin), already capped at `gross`. */
  lineDiscount: number;
  /** Resolved tax-class rate as a percentage (0..100). 0 when tax is off. */
  rate: number;
  /** Tax class name, for the invoice's per-rate breakdown. */
  label?: string;
}

export interface PosTotals {
  /** Sum of line gross, before any discount. */
  subtotal: number;
  lineDiscountTotal: number;
  /** The order-level discount, capped at what's left after line markdowns. */
  orderDiscount: number;
  /** lineDiscountTotal + orderDiscount. */
  discount: number;
  tax: number;
  /** What the customer pays — the ONLY number to quote or tender against. */
  total: number;
  /** Per-line tax, in the order given — the snapshot order_items stores. */
  taxLines: TaxLineResult[];
}

/**
 * Totals for a register sale. `requestedOrderDiscount` is capped here rather
 * than by the caller, so the screen's cap and the server's cap are the same cap.
 */
export function posTotals({
  lines,
  requestedOrderDiscount = 0,
  pricesIncludeTax = false,
  taxEnabled = true,
}: {
  lines: PosTotalsLine[];
  requestedOrderDiscount?: number;
  pricesIncludeTax?: boolean;
  taxEnabled?: boolean;
}): PosTotals {
  const safe = Array.isArray(lines) ? lines : [];

  let subtotal = 0;
  let lineDiscountTotal = 0;
  const taxLines = safe.map((l) => {
    const gross = Number.isFinite(l.gross) ? Math.max(0, l.gross) : 0;
    const lineDiscount = Number.isFinite(l.lineDiscount)
      ? Math.min(Math.max(0, l.lineDiscount), gross)
      : 0;
    subtotal += gross;
    lineDiscountTotal += lineDiscount;
    return {
      amount: gross - lineDiscount,
      rate: taxEnabled && Number.isFinite(l.rate) ? Math.max(0, l.rate) : 0,
      label: l.label,
    };
  });

  const orderDiscount = Number.isFinite(requestedOrderDiscount)
    ? Math.min(
        Math.max(0, requestedOrderDiscount),
        Math.max(0, subtotal - lineDiscountTotal),
      )
    : 0;

  const taxResult = computeTax({
    lines: taxLines,
    discount: orderDiscount,
    pricesIncludeTax,
    enabled: taxEnabled,
  });

  const discount = lineDiscountTotal + orderDiscount;
  // Inclusive prices already contain the tax — adding it again would charge it
  // twice; the carve-out is for the invoice's benefit only.
  const total = Math.max(
    0,
    round2(subtotal - discount + (pricesIncludeTax ? 0 : taxResult.totalTax)),
  );

  return {
    subtotal: round2(subtotal),
    lineDiscountTotal: round2(lineDiscountTotal),
    orderDiscount: round2(orderDiscount),
    discount: round2(discount),
    tax: round2(taxResult.totalTax),
    total,
    taxLines: taxResult.lines,
  };
}

/** Money comparison in paise — never compare rupee floats. */
export function paise(amount: number): number {
  return Math.round((Number.isFinite(amount) ? amount : 0) * 100);
}

/** Does what the cashier collected cover the bill? */
export function coversTotal(paid: number, total: number): boolean {
  return paise(paid) >= paise(total);
}

/** Change owed on a tender, never negative. */
export function changeDue(paid: number, total: number): number {
  const diff = paise(paid) - paise(total);
  return diff > 0 ? round2(diff / 100) : 0;
}
