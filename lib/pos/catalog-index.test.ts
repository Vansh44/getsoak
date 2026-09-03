import { describe, it, expect } from "vitest";
import {
  mergeCatalogDelta,
  applyLayout,
  applyStockDeltas,
  buildIndex,
  earliestCatalogWatermark,
  isOutOfStock,
  layoutCoverage,
  pruneLayout,
  itemKey,
  scanLocal,
  searchLocal,
  type CatalogItem,
  type LayoutEntry,
} from "./catalog-index";

const item = (over: Partial<CatalogItem> & { name: string }): CatalogItem => ({
  productId: over.name.toLowerCase().replace(/\W/g, "-"),
  variantId: null,
  variantName: null,
  sku: null,
  barcode: null,
  price: 100,
  image: null,
  stock: 10,
  trackInventory: true,
  allowBackorder: false,
  taxClassId: null,
  categoryId: null,
  ...over,
});

const COKE = item({ name: "Coca Cola", barcode: "8901234567890", sku: "SKU1" });
const COKE_ZERO = item({
  name: "Coca Cola Zero",
  barcode: "8901234567891",
  sku: "SKU2",
});
const MILK = item({ name: "Amul Milk 500ml", sku: "SKU3" });
const BREAD = item({ name: "Brown Bread", barcode: "  8901234567892 " });

const CATALOG = [COKE, COKE_ZERO, MILK, BREAD];
const IDX = buildIndex(CATALOG);

describe("earliestCatalogWatermark", () => {
  it("keeps the first boundary across a long paged sync", () => {
    const first = "2026-08-22T10:00:00.000Z";
    const later = "2026-08-22T10:00:15.000Z";
    expect(earliestCatalogWatermark(first, later)).toBe(first);
    expect(earliestCatalogWatermark(null, first)).toBe(first);
  });
});

describe("buildIndex", () => {
  it("indexes barcodes and SKUs", () => {
    expect(IDX.byBarcode.get("8901234567890")).toEqual([COKE]);
    expect(IDX.bySku.get("sku3")).toEqual([MILK]);
    expect(IDX.all).toHaveLength(4);
  });

  it("keeps ALL SKUs that share a code rather than overwriting", () => {
    const a = item({ name: "Loose Apple", barcode: "2000" });
    const b = item({ name: "Loose Pear", barcode: "2000" });
    expect(buildIndex([a, b]).byBarcode.get("2000")).toEqual([a, b]);
  });

  it("ignores items with no codes without corrupting the maps", () => {
    const idx = buildIndex([item({ name: "Nameless" })]);
    expect(idx.byBarcode.size).toBe(0);
    expect(idx.bySku.size).toBe(0);
  });
});

describe("scanLocal", () => {
  it("resolves an exact barcode", () => {
    expect(scanLocal(IDX, "8901234567890")).toEqual([COKE]);
  });

  it("falls back to SKU when no barcode matches", () => {
    expect(scanLocal(IDX, "SKU3")).toEqual([MILK]);
  });

  // Scanners and humans disagree about case and stray whitespace; a failed
  // scan stalls the queue, so neither may matter.
  it("is case- and whitespace-insensitive", () => {
    expect(scanLocal(IDX, "  sku1  ")).toEqual([COKE]);
    expect(scanLocal(IDX, "8901234567892")).toEqual([BREAD]);
  });

  // A miss must be distinguishable from a hit so the caller asks the server —
  // a product created since the last sync has to remain sellable.
  it("returns [] on a miss", () => {
    expect(scanLocal(IDX, "does-not-exist")).toEqual([]);
    expect(scanLocal(IDX, "")).toEqual([]);
  });

  it("prefers a barcode over a SKU when a code is both", () => {
    const a = item({ name: "By barcode", barcode: "555" });
    const b = item({ name: "By sku", sku: "555" });
    expect(scanLocal(buildIndex([a, b]), "555")).toEqual([a]);
  });
});

describe("searchLocal", () => {
  it("returns the head of the catalog for an empty query", () => {
    expect(searchLocal(IDX, "", 2)).toEqual([COKE, COKE_ZERO]);
  });

  it("ranks an exact code above name matches", () => {
    // "SKU1" is Coke's SKU; nothing else mentions it.
    expect(searchLocal(IDX, "SKU1")[0]).toEqual(COKE);
  });

  it("ranks a name prefix above a mid-string match", () => {
    const prefix = item({ name: "Milk Chocolate" });
    const middle = item({ name: "Amul Milk" });
    const res = searchLocal(buildIndex([middle, prefix]), "milk");
    expect(res[0]).toEqual(prefix);
  });

  it("matches scattered tokens", () => {
    expect(searchLocal(IDX, "milk 500")).toEqual([MILK]);
  });

  it("matches against the variant name too", () => {
    const v = item({ name: "T-Shirt", variantName: "Large Red" });
    expect(searchLocal(buildIndex([v]), "shirt large")).toEqual([v]);
  });

  it("honours the limit and returns [] when nothing matches", () => {
    expect(searchLocal(IDX, "co", 1)).toHaveLength(1);
    expect(searchLocal(IDX, "zzzz")).toEqual([]);
  });

  // The grid must not reshuffle under the cashier's finger as they type.
  it("keeps catalog order for equally-scored hits", () => {
    expect(searchLocal(IDX, "coca")).toEqual([COKE, COKE_ZERO]);
  });
});

describe("applyStockDeltas", () => {
  it("decrements only what was sold", () => {
    const out = applyStockDeltas(CATALOG, new Map([[itemKey(COKE), 3]]));
    expect(out[0].stock).toBe(7);
    expect(out[1].stock).toBe(10);
  });

  it("floors at zero rather than showing negative on-hand", () => {
    const out = applyStockDeltas(CATALOG, new Map([[itemKey(COKE), 99]]));
    expect(out[0].stock).toBe(0);
  });

  it("leaves untracked SKUs (null stock) alone", () => {
    const untracked = item({ name: "Service", stock: null });
    const out = applyStockDeltas(
      [untracked],
      new Map([[itemKey(untracked), 5]]),
    );
    expect(out[0].stock).toBeNull();
  });

  it("ignores keys that aren't in the catalog and is a no-op when empty", () => {
    expect(applyStockDeltas(CATALOG, new Map([["ghost:", 1]]))).toEqual(
      CATALOG,
    );
    expect(applyStockDeltas(CATALOG, new Map())).toBe(CATALOG);
  });

  it("distinguishes variants of the same product", () => {
    const v1 = item({ name: "Tee", productId: "p1", variantId: "v1" });
    const v2 = item({ name: "Tee", productId: "p1", variantId: "v2" });
    const out = applyStockDeltas([v1, v2], new Map([[itemKey(v2), 4]]));
    expect(out[0].stock).toBe(10);
    expect(out[1].stock).toBe(6);
  });
});

describe("sold-out ordering", () => {
  const inA = item({ name: "Apples", stock: 5 });
  const outB = item({ name: "Bananas", stock: 0 });
  const inC = item({ name: "Carrots", stock: 2 });
  const outD = item({ name: "Dates", stock: 0 });
  const untracked = item({ name: "Delivery", trackInventory: false, stock: 0 });
  const backorder = item({ name: "Eggs", stock: 0, allowBackorder: true });

  describe("isOutOfStock", () => {
    it("is true only for a tracked, non-backorderable SKU at zero", () => {
      expect(isOutOfStock(outB)).toBe(true);
      expect(isOutOfStock(inA)).toBe(false);
    });

    // A service or an untracked SKU has no stock to run out of, and a
    // backorderable one is still sellable at zero.
    it("never sidelines untracked or backorderable SKUs", () => {
      expect(isOutOfStock(untracked)).toBe(false);
      expect(isOutOfStock(backorder)).toBe(false);
    });
  });

  it("moves sold-out SKUs to the end of the idle grid", () => {
    const idx = buildIndex([outB, inA, outD, inC]);
    expect(idx.ordered.map((i) => i.name)).toEqual([
      "Apples",
      "Carrots",
      "Bananas",
      "Dates",
    ]);
  });

  it("keeps catalog order within each group", () => {
    const idx = buildIndex([inC, inA, outD, outB]);
    expect(idx.ordered.map((i) => i.name)).toEqual([
      "Carrots",
      "Apples",
      "Dates",
      "Bananas",
    ]);
  });

  // The bug this guards: slicing `all` for the empty query put whatever came
  // first in the catalog on screen, so a shop whose first rows were sold out
  // showed a grid of greyed-out cards.
  it("fills a limited idle grid with sellable items first", () => {
    const idx = buildIndex([outB, outD, inA, inC]);
    expect(searchLocal(idx, "", 2).map((i) => i.name)).toEqual([
      "Apples",
      "Carrots",
    ]);
  });

  it("ranks a sellable match above a sold-out one when searching", () => {
    // "Bananas" is sold out but an exact name match; "Banana Chips" is not.
    const chips = item({ name: "Banana Chips", stock: 3 });
    const res = searchLocal(buildIndex([outB, chips]), "banana");
    expect(res.map((i) => i.name)).toEqual(["Banana Chips", "Bananas"]);
  });

  // Still findable — the cashier often needs to tell the customer it's gone.
  it("does not hide sold-out items from search", () => {
    expect(searchLocal(buildIndex([outB]), "bananas")).toEqual([outB]);
  });

  it("re-orders after a sale empties a SKU", () => {
    const idx = buildIndex([inA, inC]);
    expect(idx.ordered[0].name).toBe("Apples");
    const after = buildIndex(
      applyStockDeltas(idx.all, new Map([[itemKey(inA), 5]])),
    );
    expect(after.ordered.map((i) => i.name)).toEqual(["Carrots", "Apples"]);
  });
});

describe("manager-arranged layout", () => {
  const milk = item({ name: "Milk", productId: "p-milk", stock: 5 });
  const bread = item({ name: "Bread", productId: "p-bread", stock: 5 });
  const eggs = item({ name: "Eggs", productId: "p-eggs", stock: 5 });
  const rice = item({ name: "Rice", productId: "p-rice", stock: 5 });
  const CAT = [milk, bread, eggs, rice];
  const at = (...ids: string[]): LayoutEntry[] =>
    ids.map((productId) => ({ productId, variantId: null }));

  // The safety property: shipping this feature must not blank a register that
  // was working before anyone arranged anything.
  it("shows the whole catalogue when no layout is configured", () => {
    expect(applyLayout(CAT, [])).toEqual(CAT);
    expect(layoutCoverage(CAT, [])).toEqual({
      shown: 4,
      total: 4,
      configured: false,
    });
  });

  it("shows only laid-out products, in the manager's order", () => {
    const out = applyLayout(CAT, at("p-eggs", "p-milk"));
    expect(out.map((i) => i.name)).toEqual(["Eggs", "Milk"]);
  });

  it("reports coverage as 'shown of total'", () => {
    expect(layoutCoverage(CAT, at("p-eggs", "p-milk"))).toEqual({
      shown: 2,
      total: 4,
      configured: true,
    });
  });

  it("drops sold-out products to the end without losing their order", () => {
    const soldOutBread = { ...bread, stock: 0 };
    const cat = [milk, soldOutBread, eggs, rice];
    const layout = at("p-bread", "p-milk", "p-eggs");
    expect(applyLayout(cat, layout).map((i) => i.name)).toEqual([
      "Milk",
      "Eggs",
      "Bread",
    ]);
  });

  // THE requirement: the shift is computed at render, never written back, so a
  // restock puts the product back in the manager's slot with no edit at all.
  it("restores a restocked product to its original slot", () => {
    const layout = at("p-bread", "p-milk", "p-eggs");
    const soldOut = [milk, { ...bread, stock: 0 }, eggs];
    expect(applyLayout(soldOut, layout).map((i) => i.name)).toEqual([
      "Milk",
      "Eggs",
      "Bread",
    ]);
    // Same layout, bread back in stock — no layout mutation involved.
    const restocked = [milk, { ...bread, stock: 9 }, eggs];
    expect(applyLayout(restocked, layout).map((i) => i.name)).toEqual([
      "Bread",
      "Milk",
      "Eggs",
    ]);
  });

  it("skips entries whose product no longer exists", () => {
    const out = applyLayout(CAT, at("p-milk", "p-deleted", "p-eggs"));
    expect(out.map((i) => i.name)).toEqual(["Milk", "Eggs"]);
  });

  it("does not count a deleted product toward coverage", () => {
    expect(layoutCoverage(CAT, at("p-milk", "p-deleted"))).toMatchObject({
      shown: 1,
      total: 4,
    });
  });

  it("distinguishes variants of the same product", () => {
    const small = item({ name: "Tee S", productId: "p-tee", variantId: "v-s" });
    const large = item({ name: "Tee L", productId: "p-tee", variantId: "v-l" });
    const out = applyLayout(
      [small, large],
      [{ productId: "p-tee", variantId: "v-l" }],
    );
    expect(out).toEqual([large]);
  });

  describe("pruneLayout", () => {
    it("removes stale entries and de-duplicates, keeping order", () => {
      const messy = at("p-eggs", "p-gone", "p-milk", "p-eggs");
      expect(pruneLayout(CAT, messy)).toEqual(at("p-eggs", "p-milk"));
    });

    it("is a no-op on an already-clean layout", () => {
      const clean = at("p-milk", "p-bread");
      expect(pruneLayout(CAT, clean)).toEqual(clean);
    });
  });
});

// ── mergeCatalogDelta (roadmap Step 19) ────────────────────────────────────
// A delta that only ADDS is wrong: the catalogue query filters on
// status='published', so a withdrawn product simply stops matching and the
// register would go on selling it.

describe("mergeCatalogDelta", () => {
  const item = (
    productId: string,
    variantId: string | null = null,
    name = productId,
  ) =>
    ({
      productId,
      variantId,
      name,
      variantName: null,
      price: 100,
      stock: 5,
      trackInventory: true,
      allowBackorder: false,
      barcode: null,
      sku: null,
      image: null,
      taxClassId: null,
      categoryId: null,
    }) as unknown as CatalogItem;

  it("leaves untouched products alone", () => {
    const out = mergeCatalogDelta([item("a"), item("b")], [], []);
    expect(out.map((i) => i.productId)).toEqual(["a", "b"]);
  });

  it("★ a changed product REPLACES its cached version", () => {
    const out = mergeCatalogDelta(
      [item("a", null, "old"), item("b")],
      [item("a", null, "new")],
    );
    expect(out.find((i) => i.productId === "a")?.name).toBe("new");
    expect(out).toHaveLength(2);
  });

  it("★★ a withdrawn product is DROPPED", () => {
    // The whole reason removals exist. Without this the till keeps selling
    // something the merchant unpublished.
    const out = mergeCatalogDelta([item("a"), item("b")], [], ["a"]);
    expect(out.map((i) => i.productId)).toEqual(["b"]);
  });

  it("★★ a product is replaced WHOLESALE, so a deleted variant disappears", () => {
    // Upserting by product+variant would leave v2 behind forever: the delta
    // simply stops mentioning it, which is indistinguishable from "unchanged"
    // unless the product's SKUs are replaced as a set.
    const out = mergeCatalogDelta(
      [item("a", "v1"), item("a", "v2")],
      [item("a", "v1")],
    );
    expect(out).toHaveLength(1);
    expect(out[0].variantId).toBe("v1");
  });

  it("★ a new product is added", () => {
    const out = mergeCatalogDelta([item("a")], [item("b")]);
    expect(out.map((i) => i.productId).sort()).toEqual(["a", "b"]);
  });

  it("★★ removal wins over a contradictory change", () => {
    // The server should never send both; if it does, "no longer sellable" is
    // the safer reading than putting it back on the grid.
    const out = mergeCatalogDelta([item("a")], [item("a")], ["a"]);
    expect(out).toEqual([]);
  });

  it("removing something not cached is a no-op, not a crash", () => {
    expect(mergeCatalogDelta([item("a")], [], ["zzz"])).toHaveLength(1);
  });

  it("an empty delta preserves the cache exactly", () => {
    const cached = [item("a"), item("b", "v1")];
    expect(mergeCatalogDelta(cached, [])).toEqual(cached);
  });
});
