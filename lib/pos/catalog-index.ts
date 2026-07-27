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
  /** A code can map to SEVERAL SKUs — mislabelled supplier barcodes are
   *  common in retail, so the register disambiguates rather than guessing. */
  byBarcode: Map<string, CatalogItem[]>;
  bySku: Map<string, CatalogItem[]>;
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
  return { all: items, byBarcode, bySku };
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
  if (!q) return index.all.slice(0, limit);

  const qCode = normCode(query);
  const tokens = q.split(/\s+/).filter(Boolean);
  const hits: Array<{ item: CatalogItem; score: number; i: number }> = [];
  for (let i = 0; i < index.all.length; i++) {
    const item = index.all[i];
    const score = scoreItem(item, qCode, tokens);
    if (score > 0) hits.push({ item, score, i });
  }
  // Ties keep catalog order, so the grid doesn't reshuffle as the cashier types.
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
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
