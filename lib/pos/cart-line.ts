// ---------------------------------------------------------------------------
// One cart line, and the ONE way to build one from the catalogue.
//
// ★★ THERE WERE TWO BUILDERS AND THEY DISAGREED. `addItem` filled every field;
// the parked-sale resume path hand-built a partial object and finished it with
// `as CartLine`, which silenced the compiler about the five it omitted —
// `taxClassId`, `categoryId`, `stock`, `trackInventory` and `allowBackorder`.
// So a RESUMED cart quoted `taxClassId: undefined` to lib/pos/totals.ts, which
// resolves a rate from RegisterConfig.taxRates and therefore found none: the
// screen showed a tax-free total while `placePosSale` re-read the tax class and
// charged tax. That is the exact two-ends-disagree failure `posTotals` exists to
// prevent (CODEBASE.md §22), and the missing `categoryId` silently un-scoped
// every category offer on a resumed basket besides.
//
// A blanket `as` cast on a wide object is the hazard `OrderInsert` was
// introduced for on the `orders` inserts. `cartLineFrom` is the fix in the same
// shape: one builder, no cast, so a field added to a line has exactly one place
// to be filled and forgetting it is a BUILD error rather than a silent zero.
// ---------------------------------------------------------------------------

import { itemKey, type CatalogItem } from "./catalog-index";

export interface CartLine {
  key: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  image: string | null;
  unitPrice: number;
  quantity: number;
  /** Markdown on this line only, in rupees — for one damaged/expiring unit.
   *  Re-derived and capped server-side; this is a display value. */
  lineDiscount: number;
  /** Live stock at this location; null = untracked. */
  stock: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  /** Resolved to a rate via config.taxRates so the screen can quote the
   *  tax-inclusive total (see lib/pos/totals.ts). */
  taxClassId: string | null;
  /** The product's category, for offer scoping. Carried on the cart line so
   *  the quote and the charge see the same scope (docs/offers-plan.md). */
  categoryId: string | null;
}

/**
 * Turn a catalogue entry into a cart line.
 *
 * ★ THE CATALOGUE IS THE SOURCE OF NAME, PRICE, TAX CLASS AND CATEGORY; the
 * caller supplies only the CHOICES (how many, and any markdown). That split is
 * what lets a line be rebuilt from a stored choice — by the parked-sale resume
 * and by cart restore (cart-storage.ts) — and re-priced at today's prices
 * rather than the ones in force when the choice was made. Nothing here is ever
 * the basis for a charge: `placePosSale` re-reads all of it at completion.
 */
export function cartLineFrom(
  item: CatalogItem,
  choice: { quantity: number; lineDiscount?: number },
): CartLine {
  return {
    key: itemKey(item),
    productId: item.productId,
    variantId: item.variantId,
    name: item.name,
    variantName: item.variantName,
    image: item.image,
    unitPrice: item.price,
    quantity: choice.quantity,
    lineDiscount: choice.lineDiscount ?? 0,
    stock: item.stock,
    trackInventory: item.trackInventory,
    allowBackorder: item.allowBackorder,
    taxClassId: item.taxClassId ?? null,
    categoryId: item.categoryId ?? null,
  };
}
