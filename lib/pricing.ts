// Shared catalog pricing helpers — used by the dashboard, shop grid, and PDP.

export function formatPrice(n: number): string {
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

// Percentage off, rounded. Returns 0 when there's no genuine discount.
export function discountPercent(base: number, selling: number): number {
  if (!Number.isFinite(base) || !Number.isFinite(selling)) return 0;
  if (base <= 0 || selling >= base) return 0;
  return Math.round(((base - selling) / base) * 100);
}

/**
 * Exactly the fields `variantEffectiveSelling` reads — deliberately narrower
 * than `PricedVariant`.
 *
 * ★ THE NARROWNESS IS THE POINT. The server's checkout reads select only the
 * price columns they need and never `base_price`, so a parameter type that
 * demanded it would not accept a DB row — and the way round that is to inline
 * `special ?? selling` at the call site, i.e. a second copy of this rule. That
 * is exactly how the storefront came to DISPLAY `special_price` while
 * `placeOrder` CHARGED `selling_price`. Keep this shape at the minimum the
 * function actually reads so every caller — display, cart and charge — can use
 * the one helper.
 */
export interface VariantSellingFields {
  selling_price: number;
  // Overrides selling_price when present. NULL/undefined → variant prices as
  // normal. Used to flag a temporary sale on a single variant (e.g. push the
  // bigger pack at an aggressive discount); the storefront also renders a
  // "best value" price tag on the variant chip when this is set.
  special_price?: number | null;
}

export interface PricedVariant extends VariantSellingFields {
  base_price: number;
  sort_order?: number;
}

export interface PricedLike {
  base_price: number;
  selling_price: number;
  variants?: PricedVariant[];
}

export interface EffectivePricing {
  base: number; // original price (struck through when discounted)
  selling: number; // price actually charged
  discount: number; // percent off, 0 when none
  hasVariants: boolean;
  /**
   * The price `selling` is ON SALE FROM — the chosen variant's
   * `selling_price` when a `special_price` is being charged, and equal to
   * `selling` otherwise.
   *
   * ★★ THIS IS NOT `base`, AND CONFUSING THE TWO BREAKS OFFER PRICING.
   * `base` is the struck-through MRP, which is a list price rather than a
   * price this product was recently sold at. The offer engine reads
   * `regularUnitPrice` as "what this line is discounted from" and uses it to
   * decide `onSalePrice` — so passing MRP marks EVERY product with an MRP set
   * as on sale, and under the default `best` mode the offer is then measured
   * against the MRP and scores nothing. The shop grid's badge did exactly that
   * and silently showed no badge for most of a catalogue.
   *
   * Only `effectivePricing` knows which variant `selling` came from, so this is
   * the only place that can answer it — computing it at a call site means
   * re-deriving the default-variant choice and getting it wrong differently.
   */
  regularSelling: number;
}

// Normalize a single base/selling pair: fall back to base when no selling
// price is set, and never let selling exceed base.
function normalizePair(base: number, selling: number) {
  const b = Number.isFinite(base) && base > 0 ? base : 0;
  let s = Number.isFinite(selling) && selling > 0 ? selling : b;
  if (b > 0 && s > b) s = b;
  return { base: b, selling: s };
}

// The "from" / display pricing for a product. With variants, we show the
// DEFAULT variant — i.e. the lowest sort_order, which is the first row the
// admin entered in the variants editor. (sort_order is stamped from the
// editor's row index in product-actions.sanitizeVariants.) Without variants,
// the product-level base/selling pair is used.
export function effectivePricing(p: PricedLike): EffectivePricing {
  const hasVariants = !!(p.variants && p.variants.length > 0);

  if (!hasVariants) {
    const pair = normalizePair(p.base_price, p.selling_price);
    return {
      base: pair.base,
      selling: pair.selling,
      discount: discountPercent(pair.base, pair.selling),
      hasVariants: false,
      // A product carries no special price — `special_price` is variant-only —
      // so what is charged IS the regular price, and the engine reads the two
      // being equal as "not on sale".
      regularSelling: pair.selling,
    };
  }

  // Pick the default: lowest sort_order. Legacy rows without sort_order fall
  // back to their array index so we still get a stable choice.
  const sorted = [...p.variants!].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );
  // special_price (when set) overrides selling_price for the chosen variant.
  // It's still clamped against base_price, so a typo can't display free.
  const v = sorted[0];
  const effSelling = variantEffectiveSelling(v);
  const def = normalizePair(v.base_price, effSelling);

  return {
    base: def.base,
    selling: def.selling,
    discount: discountPercent(def.base, def.selling),
    hasVariants: true,
    // ★ The chosen variant's REGULAR price, clamped the same way `selling` is
    // so the pair cannot invert. Equal to `selling` when no special price is
    // set, which is what "not on sale" looks like to the engine.
    regularSelling: normalizePair(v.base_price, v.selling_price).selling,
  };
}

/**
 * ★ THE ONE RULE FOR WHAT A VARIANT COSTS: special_price when set (non-null,
 * > 0), otherwise the regular selling_price.
 *
 * Every surface that shows, sums or CHARGES a variant price must come through
 * here — the PDP and shop grid, the cart's tax basis (`getCartTaxRates`) and
 * the authoritative charge (`placeOrder`). `placePosSale` applies the
 * identical rule at the till.
 *
 * ⚠ It was not always shared, and the gap was a real overcharge: the PDP used
 * this helper while `placeOrder` read `selling_price` directly, so a variant on
 * sale displayed ₹450 and billed ₹1,000 online while the till charged ₹450.
 * Same class of defect `lib/pos/totals.ts` exists to prevent. Do not inline
 * `special ?? selling` anywhere; call this.
 */
export function variantEffectiveSelling(v: VariantSellingFields): number {
  if (v.special_price != null && v.special_price > 0) return v.special_price;
  return v.selling_price;
}

/** Does this variant have a special (sale) price that should show a tag? */
export function hasSpecialPrice(v: { special_price?: number | null }): boolean {
  return v.special_price != null && v.special_price > 0;
}
