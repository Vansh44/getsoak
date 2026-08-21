// POS catalog index — the local search/scan engine behind the register's
// "<50 ms, zero network" promise (docs/pos-plan.md §10).
//
// PURE and browser-agnostic on purpose: persistence (IndexedDB) lives in
// catalog-store.ts and the React wiring in use-catalog.ts, so the matching
// rules that decide what a scan resolves to can be unit-tested outright.
//
// ⚠ The cache is a DISPLAY accelerator, never an authority. placePosSale
// re-reads every price from the DB and reserves stock atomically at the
// register's location, so a stale entry can only ever cause a UI mismatch —
// it can't mis-charge a customer or oversell a SKU.

import type { PosCatalogItem } from "@/app/actions/pos-sale-actions";

export type CatalogItem = PosCatalogItem;

export interface CatalogIndex {
  /** Every sellable SKU, in the order the server returned them. */
  all: CatalogItem[];
  /** `all`, with sold-out SKUs moved to the end (stable otherwise). This is
   *  what the register's idle grid shows: a cashier reaching for a product
   *  should not have to scroll past things they cannot sell. */
  ordered: CatalogItem[];
  /** A code can map to SEVERAL SKUs — mislabelled supplier barcodes are
   *  common in retail, so the register disambiguates rather than guessing. */
  byBarcode: Map<string, CatalogItem[]>;
  bySku: Map<string, CatalogItem[]>;
}

/**
 * Can this SKU be sold right now? The single definition of "sold out" for the
 * register — the grid's disabled state and the ordering below must agree, or
 * the greyed-out cards won't be the ones at the end.
 */
export function isOutOfStock(i: CatalogItem): boolean {
  return i.trackInventory && !i.allowBackorder && (i.stock ?? 0) <= 0;
}

export const itemKey = (i: {
  productId: string;
  variantId: string | null;
}): string => `${i.productId}:${i.variantId ?? ""}`;

/** Codes are matched case-insensitively and space-insensitively: scanners and
 *  humans disagree about both, and a failed scan is a stalled queue. */
const normCode = (v: string): string =>
  v.trim().toLowerCase().replace(/\s+/g, "");

const normText = (v: string): string => v.trim().toLowerCase();

function pushInto(
  map: Map<string, CatalogItem[]>,
  code: string | null | undefined,
  item: CatalogItem,
): void {
  if (!code) return;
  const k = normCode(code);
  if (!k) return;
  const list = map.get(k);
  if (list) list.push(item);
  else map.set(k, [item]);
}

export function buildIndex(items: CatalogItem[]): CatalogIndex {
  const byBarcode = new Map<string, CatalogItem[]>();
  const bySku = new Map<string, CatalogItem[]>();
  for (const it of items) {
    pushInto(byBarcode, it.barcode, it);
    pushInto(bySku, it.sku, it);
  }
  // Stable partition rather than a sort: equal-availability items keep the
  // catalog's own order, so the grid doesn't reshuffle between syncs.
  const inStock: CatalogItem[] = [];
  const soldOut: CatalogItem[] = [];
  for (const it of items) (isOutOfStock(it) ? soldOut : inStock).push(it);

  return { all: items, ordered: inStock.concat(soldOut), byBarcode, bySku };
}

export const EMPTY_INDEX: CatalogIndex = buildIndex([]);

/**
 * Resolve a scanned/typed code to SKUs. Barcode wins over SKU: the barcode is
 * what is physically on the product in the cashier's hand.
 *
 * Returns [] on a miss so the caller can fall back to the server — a product
 * added after the last sync is not in the cache, and refusing to sell it
 * because of our own staleness would be indefensible.
 */
export function scanLocal(index: CatalogIndex, code: string): CatalogItem[] {
  const k = normCode(code ?? "");
  if (!k) return [];
  return index.byBarcode.get(k) ?? index.bySku.get(k) ?? [];
}

// Ranking: an exact code beats a name prefix beats a substring beats scattered
// tokens. Retail search is short and prefix-shaped ("coke", "mag"), so a
// prefix hit is worth far more than a match buried mid-string.
const SCORE_BARCODE = 1000;
const SCORE_SKU = 900;
const SCORE_NAME_EXACT = 500;
const SCORE_NAME_PREFIX = 100;
const SCORE_NAME_SUBSTR = 50;
const SCORE_TOKENS = 25;

function scoreItem(it: CatalogItem, q: string, tokens: string[]): number {
  if (it.barcode && normCode(it.barcode) === q) return SCORE_BARCODE;
  if (it.sku && normCode(it.sku) === q) return SCORE_SKU;

  const name = normText(
    it.variantName ? `${it.name} ${it.variantName}` : it.name,
  );
  if (name === q) return SCORE_NAME_EXACT;
  if (name.startsWith(q)) return SCORE_NAME_PREFIX;
  if (name.includes(q)) return SCORE_NAME_SUBSTR;
  // "milk 500" should still find "Amul Milk 500ml".
  if (tokens.length > 1 && tokens.every((t) => name.includes(t)))
    return SCORE_TOKENS;
  return 0;
}

/**
 * Local browse-as-you-type. A linear scan is deliberate: at a few thousand
 * SKUs it costs ~1 ms, which is far below the frame budget, and it avoids an
 * inverted index that would have to be invalidated on every sync.
 *
 * An empty query returns the head of the catalog — the register's idle grid.
 */
export function searchLocal(
  index: CatalogIndex,
  query: string,
  limit = 24,
): CatalogItem[] {
  const q = normText(query ?? "");
  if (!q) return index.ordered.slice(0, limit);

  const qCode = normCode(query);
  const tokens = q.split(/\s+/).filter(Boolean);
  const hits: Array<{ item: CatalogItem; score: number; i: number }> = [];
  for (let i = 0; i < index.all.length; i++) {
    const item = index.all[i];
    const score = scoreItem(item, qCode, tokens);
    if (score > 0) hits.push({ item, score, i });
  }
  // Availability first, then relevance, then catalog order. A sold-out exact
  // match still appears — the cashier may need to tell the customer it's gone —
  // just never above something they can actually ring up.
  hits.sort(
    (a, b) =>
      Number(isOutOfStock(a.item)) - Number(isOutOfStock(b.item)) ||
      b.score - a.score ||
      a.i - b.i,
  );
  return hits.slice(0, limit).map((h) => h.item);
}

/**
 * Decrement cached stock for what was just sold, so the next scan of the same
 * SKU reflects the sale without waiting for a sync. Untracked SKUs (stock
 * null) are left alone; tracked ones floor at 0 rather than going negative,
 * since a negative on-hand is never a truth the register should display.
 */
export function applyStockDeltas(
  items: CatalogItem[],
  sold: Map<string, number>,
): CatalogItem[] {
  if (sold.size === 0) return items;
  return items.map((it) => {
    const qty = sold.get(itemKey(it));
    if (!qty || it.stock === null) return it;
    return { ...it, stock: Math.max(0, it.stock - qty) };
  });
}

// ---- Manager-arranged layout ------------------------------------------------

/** One slot in a manager's register layout (supabase/pos_09_register_layout.sql). */
export interface LayoutEntry {
  productId: string;
  variantId: string | null;
}

export const layoutKey = (e: LayoutEntry): string =>
  `${e.productId}:${e.variantId ?? ""}`;

/**
 * Order the idle grid the way the manager arranged it.
 *
 * An EMPTY layout means "not configured" and shows the whole catalogue — the
 * feature must never blank a register that predates it, and a manager who
 * removes every tile has almost certainly not asked for an empty till.
 *
 * Otherwise only laid-out products appear, in the manager's order, EXCEPT that
 * sold-out ones drop to the end. That shift is computed here at render time
 * rather than written back to the layout, which is what makes a restock restore
 * a product to its original slot with no edit and no bookkeeping.
 *
 * Entries the catalogue no longer contains are skipped, so deleting a product
 * quietly removes its tile instead of leaving a hole or throwing.
 */
export function applyLayout(
  items: CatalogItem[],
  layout: LayoutEntry[],
): CatalogItem[] {
  if (layout.length === 0) {
    const inStock: CatalogItem[] = [];
    const soldOut: CatalogItem[] = [];
    for (const it of items) (isOutOfStock(it) ? soldOut : inStock).push(it);
    return inStock.concat(soldOut);
  }

  const byKey = new Map(items.map((i) => [itemKey(i), i]));
  const placed: CatalogItem[] = [];
  const placedSoldOut: CatalogItem[] = [];
  for (const entry of layout) {
    const item = byKey.get(layoutKey(entry));
    if (!item) continue; // deleted or unpublished since the layout was saved
    (isOutOfStock(item) ? placedSoldOut : placed).push(item);
  }
  return placed.concat(placedSoldOut);
}

/**
 * How many of the store's sellable SKUs the layout actually shows — the
 * "12 of 20" the register puts above the grid, so a manager can see at a
 * glance that eight products are reachable only by search or scan.
 *
 * Counts against the live catalogue, so an entry whose product was deleted
 * stops being counted rather than inflating the figure forever.
 */
export function layoutCoverage(
  items: CatalogItem[],
  layout: LayoutEntry[],
): { shown: number; total: number; configured: boolean } {
  const total = items.length;
  if (layout.length === 0) return { shown: total, total, configured: false };
  const present = new Set(items.map(itemKey));
  const seen = new Set<string>();
  for (const e of layout) {
    const k = layoutKey(e);
    if (present.has(k)) seen.add(k);
  }
  return { shown: seen.size, total, configured: true };
}

/** Drop entries whose product is gone, and de-duplicate, preserving order. */
export function pruneLayout(
  items: CatalogItem[],
  layout: LayoutEntry[],
): LayoutEntry[] {
  const present = new Set(items.map(itemKey));
  const seen = new Set<string>();
  const out: LayoutEntry[] = [];
  for (const e of layout) {
    const k = layoutKey(e);
    if (!present.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * Fold a DELTA into a cached catalogue (roadmap Step 19).
 *
 * ★ PURE, and separate from the index build, so the merge rule is testable
 * without IndexedDB, a network, or a register. Returns a new array; the caller
 * rebuilds the index from it.
 *
 * ★★ ITEMS ARE KEYED BY PRODUCT+VARIANT, NOT BY PRODUCT. A delta for one
 * product carries every sellable SKU under it, so replacing by product id alone
 * would drop variants the delta did not mention — which is exactly the case a
 * variant-level edit produces.
 *
 * ★ REMOVALS ARE BY PRODUCT ID, because that is what an unpublish acts on: the
 * whole product leaves the catalogue with all its variants.
 */
export function mergeCatalogDelta(
  cached: CatalogItem[],
  changed: CatalogItem[],
  removedProductIds: string[] = [],
): CatalogItem[] {
  const gone = new Set(removedProductIds);
  // Every product the delta MENTIONS is replaced wholesale by what it sent, so
  // a variant deleted from a product still in the catalogue disappears too.
  const rewritten = new Set(changed.map((i) => i.productId));

  const out: CatalogItem[] = [];
  for (const item of cached) {
    if (gone.has(item.productId)) continue;
    if (rewritten.has(item.productId)) continue;
    out.push(item);
  }
  for (const item of changed) {
    // A product can be in both lists only if the server contradicted itself;
    // removal wins, because "no longer sellable" is the safer reading.
    if (gone.has(item.productId)) continue;
    out.push(item);
  }
  return out;
}
