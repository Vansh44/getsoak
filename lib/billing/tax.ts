// ---------------------------------------------------------------------------
// Pure tax math — the single source of truth for turning cart lines + a store's
// tax config into per-line tax, a total, and a per-rate breakdown for invoices.
// No imports, fully deterministic, so it can be unit-tested and shared by the
// checkout server action AND the invoice renderer.
//
// Two modes (store-wide toggle, see BillingSettings.pricesIncludeTax):
//   * EXCLUSIVE — listed prices are net; tax is ADDED on top of the total.
//   * INCLUSIVE — listed prices already contain tax; the tax is CARVED OUT for
//     reporting but NOT added again (the total stays the listed price).
//
// Discounts (coupons) reduce the taxable base: the order discount is allocated
// across lines proportionally to each line's amount, and tax is computed on the
// discounted amount (Shopify applies tax after discounts).
// ---------------------------------------------------------------------------

export interface TaxLineInput {
  /** price * quantity (listed price), before any discount. */
  amount: number;
  /** Tax rate for this line as a percentage (0..100). */
  rate: number;
  /** Optional label (tax class name) for the per-rate breakdown. */
  label?: string;
  /**
   * This line's OWN discount, already allocated to it — an offer's share
   * (`order_items.offer_discount`) or a manual per-line markdown.
   *
   * ★ THIS EXISTS BECAUSE A SCOPED DISCOUNT IS NOT PROPORTIONAL. The `discount`
   * argument below is spread across lines in proportion to their value, which
   * is right for an order-level discount and WRONG for one that belongs to a
   * single line. A ₹1,000 shirt at 18% beside a ₹1,000 book at 5%, with ₹200
   * off the shirt, would otherwise be taxed as ₹100 off each — understating the
   * shirt's base, overstating the book's, and misstating the GST on an invoice
   * with nothing anywhere reporting an error. Subtracted BEFORE the
   * proportional allocation, so the two compose rather than compete.
   */
  discount?: number;
}

export interface TaxLineResult {
  amount: number;
  /** The line's own allocated discount, echoed back for the caller. */
  lineDiscount: number;
  rate: number;
  label?: string;
  /** The line amount after its share of the order discount. */
  discountedAmount: number;
  /** Net (ex-tax) taxable value of this line. */
  taxableValue: number;
  /** Tax for this line. */
  tax: number;
}

export interface TaxRateBucket {
  rate: number;
  label: string;
  /** Net taxable value at this rate. */
  taxableValue: number;
  tax: number;
}

export interface TaxResult {
  /** Total tax (ADDED to the total when exclusive; already INCLUDED when inclusive). */
  totalTax: number;
  /** Whether prices were inclusive (echoed back for the caller). */
  inclusive: boolean;
  lines: TaxLineResult[];
  /** Grouped by rate — the invoice tax breakdown. */
  byRate: TaxRateBucket[];
}

/** Round to 2 decimal places (money), guarding float error. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute tax for a set of lines.
 *
 * @param lines    per-line listed amount (price*qty) + resolved rate, and
 *                 optionally that line's OWN already-allocated discount
 * @param discount ORDER-level discount (>= 0), allocated proportionally across
 *                 what each line has left after its own discount
 * @param pricesIncludeTax  inclusive vs exclusive semantics
 * @param enabled  when false, everything is zero-tax (feature off)
 */
export function computeTax({
  lines,
  discount = 0,
  pricesIncludeTax = false,
  enabled = true,
}: {
  lines: TaxLineInput[];
  discount?: number;
  pricesIncludeTax?: boolean;
  enabled?: boolean;
}): TaxResult {
  const safeLines = Array.isArray(lines) ? lines : [];

  // Each line's own discount comes off first and is never spread. What remains
  // is the base the ORDER-level discount is allocated across.
  const lineAmounts = safeLines.map((l) =>
    Number.isFinite(l.amount) ? Math.max(0, l.amount) : 0,
  );
  const lineDiscounts = safeLines.map((l, i) => {
    const d = Number.isFinite(l.discount)
      ? Math.max(0, l.discount as number)
      : 0;
    return Math.min(d, lineAmounts[i]);
  });
  const netAmounts = lineAmounts.map((a, i) => round2(a - lineDiscounts[i]));
  const netTotal = netAmounts.reduce((s, a) => s + a, 0);

  const disc = Number.isFinite(discount)
    ? Math.min(Math.max(0, discount), netTotal)
    : 0;

  const results: TaxLineResult[] = safeLines.map((l, i) => {
    const amount = lineAmounts[i];
    const rate = enabled && Number.isFinite(l.rate) ? Math.max(0, l.rate) : 0;
    // Allocate the order discount proportionally over what is LEFT on each
    // line. With no per-line discounts this is byte-identical to allocating
    // over the listed amounts, so existing callers are unaffected.
    const share = netTotal > 0 ? netAmounts[i] / netTotal : 0;
    const discountedAmount = round2(netAmounts[i] - disc * share);

    let tax = 0;
    let taxableValue = discountedAmount;
    if (rate > 0) {
      if (pricesIncludeTax) {
        // Tax carved out of the (discounted) gross amount.
        tax = round2((discountedAmount * rate) / (100 + rate));
        taxableValue = round2(discountedAmount - tax);
      } else {
        // Tax added on top of the (discounted) net amount.
        tax = round2((discountedAmount * rate) / 100);
        taxableValue = discountedAmount;
      }
    }

    return {
      amount,
      lineDiscount: lineDiscounts[i],
      rate,
      label: l.label,
      discountedAmount,
      taxableValue,
      tax,
    };
  });

  const totalTax = round2(results.reduce((s, r) => s + r.tax, 0));

  // Group by rate for the invoice breakdown.
  const buckets = new Map<number, TaxRateBucket>();
  for (const r of results) {
    if (r.rate <= 0) continue;
    const key = r.rate;
    const existing = buckets.get(key);
    if (existing) {
      existing.taxableValue = round2(existing.taxableValue + r.taxableValue);
      existing.tax = round2(existing.tax + r.tax);
    } else {
      buckets.set(key, {
        rate: r.rate,
        label: r.label || `Tax ${r.rate}%`,
        taxableValue: r.taxableValue,
        tax: r.tax,
      });
    }
  }
  const byRate = [...buckets.values()].sort((a, b) => a.rate - b.rate);

  return { totalTax, inclusive: pricesIncludeTax, lines: results, byRate };
}
