import { describe, it, expect } from "vitest";
import {
  applyStockDeltas,
  buildIndex,
  itemKey,
  scanLocal,
  searchLocal,
  type CatalogItem,
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
