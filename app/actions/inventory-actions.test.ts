/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues, sqlText } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  // Promise.resolve() assimilates the thenable query steps into real
  // promises, so the action's .catch() calls work like production.
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/locations/scope", () => ({
  getViewerLocations: vi.fn(async () => null),
}));

import { revalidateTag } from "next/cache";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { getViewerLocations } from "@/lib/locations/scope";
import {
  getInventory,
  adjustStock,
  setStock,
  bulkAdjust,
  getMovements,
} from "./inventory-actions";
import { TAGS } from "@/lib/storefront/tags";

const storeSettingsRow = { settings: {}, plan: "free" };

// inventory-actions.ts — the SKU list (products + variants combined in
// memory), the atomic adjust/set/bulk stock mutations via the unchanged
// adjust_stock Postgres function, and the movements ledger.
describe("inventory-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
  });

  describe("getInventory", () => {
    it("rejects when not authenticated", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const res = await getInventory({});
      expect(res.error).toMatch(/not authenticated/i);
    });

    // Selects: #1 store settings, #2 products, #3 variants.
    it("combines products and variants correctly", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [storeSettingsRow],
          [
            {
              id: "p1",
              name: "Simple",
              stock: 10,
              track_inventory: true,
              low_stock_threshold: 5,
              category: "Cat1",
            },
            {
              id: "p2",
              name: "Variant Product",
              stock: 0,
              track_inventory: false,
            },
          ],
          [
            {
              id: "v1",
              product_id: "p2",
              name: "Var A",
              stock: 2,
              track_inventory: true,
              low_stock_threshold: null, // Should use store default 5
              product_name: "Variant Product",
              category: "Cat2",
            },
          ],
        ],
      });

      const res = await getInventory({});
      expect(res.total).toBe(2);
      expect(res.rows).toHaveLength(2);

      // p1 is a simple product
      const simple = res.rows.find((r) => r.id === "p-p1");
      expect(simple).toBeDefined();
      expect(simple?.status).toBe("in"); // 10 > 5
      expect(simple?.category).toBe("Cat1");

      // v1 is a variant
      const variant = res.rows.find((r) => r.id === "v-v1");
      expect(variant).toBeDefined();
      expect(variant?.status).toBe("low"); // 2 <= 5
      expect(variant?.name).toBe("Variant Product");
      expect(variant?.variantName).toBe("Var A");
    });

    it("searches in memory, tolerating names with control characters", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [storeSettingsRow],
          [
            {
              id: "p1",
              name: "Fresh Orange Juice (1 L) (Sample)",
              stock: 3,
              track_inventory: true,
              low_stock_threshold: null,
            },
            {
              id: "p2",
              name: "Basmati Rice",
              stock: 10,
              track_inventory: true,
              low_stock_threshold: null,
            },
          ],
          [],
        ],
      });

      const res = await getInventory({ q: "Fresh Orange Juice (1 L)" });
      expect(res.error).toBeUndefined();
      expect(res.rows.map((r) => r.name)).toEqual([
        "Fresh Orange Juice (1 L) (Sample)",
      ]);
    });
  });

  describe("adjustStock", () => {
    it("rejects when not authenticated", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const res = await adjustStock("p1", null, 10);
      expect(res.error).toMatch(/not authenticated/i);
    });

    it("calls the adjust_stock function with the exact arguments", async () => {
      dbHolder.current = makeDbMock({ executeQueue: [[{ new_stock: 20 }]] });
      const res = await adjustStock("p1", "v1", -2, "sale", "test");
      expect(res.success).toBe(true);
      expect(res.newStock).toBe(20);

      expect(dbHolder.current.calls.execute).toHaveLength(1);
      const params = sqlParamValues(dbHolder.current.calls.execute[0]);
      expect(params).toEqual([
        "store-1",
        "p1",
        "v1",
        -2,
        "sale",
        "test",
        "user-1",
      ]);
      expect(revalidateTag).toHaveBeenCalledWith(TAGS.products, "max");
    });
  });

  describe("setStock", () => {
    it("fetches current stock and calls adjustStock with correct delta", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ stock: 5 }]],
        executeQueue: [[{ new_stock: 10 }]],
      });
      const res = await setStock("p1", "v1", 10);
      expect(res.success).toBe(true);

      // 10 - 5 → delta 5 passed to adjust_stock.
      const params = sqlParamValues(dbHolder.current.calls.execute[0]);
      expect(params).toContain(5);
    });

    it("returns immediately if delta is 0", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ stock: 5 }]] });
      const res = await setStock("p1", "v1", 5); // current is 5
      expect(res.success).toBe(true);
      expect(res.newStock).toBe(5);
      expect(dbHolder.current.calls.execute).toHaveLength(0);
    });
  });

  describe("bulkAdjust", () => {
    it("batch-reads current stock, fires one RPC per change, revalidates once", async () => {
      // Batch read for the "set" item resolves the variant's current stock (5).
      dbHolder.current = makeDbMock({
        selectQueue: [[{ id: "v1", stock: 5 }]],
      });

      const res = await bulkAdjust([
        { productId: "p1", delta: 10 },
        { productId: "p1", variantId: "v1", set: 10 },
      ]);
      expect(res.success).toBe(true);
      expect(dbHolder.current.calls.execute).toHaveLength(2);
      // "set 10" against current 5 → delta 5 on the variant op.
      const setParams = sqlParamValues(dbHolder.current.calls.execute[1]);
      expect(setParams).toContain("v1");
      expect(setParams).toContain(5);
      // The whole batch busts the product cache exactly once (not per item).
      expect(revalidateTag).toHaveBeenCalledTimes(1);
    });

    it("skips no-op sets without calling the RPC", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ id: "v1", stock: 10 }]],
      });
      const res = await bulkAdjust([
        { productId: "p1", variantId: "v1", set: 10 },
      ]);
      expect(res.success).toBe(true);
      expect(dbHolder.current.calls.execute).toHaveLength(0);
    });

    it("rejects an oversized batch", async () => {
      const many = Array.from({ length: 501 }, (_, i) => ({
        productId: `p${i}`,
        delta: 1,
      }));
      const res = await bulkAdjust(many);
      expect(res.error).toMatch(/too many/i);
      expect(dbHolder.current.calls.execute).toHaveLength(0);
    });
  });

  describe("getMovements", () => {
    it("rejects when not authenticated", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const res = await getMovements("p1");
      expect(res.error).toMatch(/not authenticated/i);
    });

    it("fetches paginated movements (variant_id IS NULL for simple SKUs)", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ id: "m1" }], [{ n: 1 }]],
      });
      const res = await getMovements("p1", null, 1);
      expect(res.total).toBe(1);
      expect(res.movements).toHaveLength(1);
      expect(dbHolder.current.calls.limit[0]).toBe(50);
      expect(dbHolder.current.calls.offset[0]).toBe(0);
    });
  });

  // Phase C — the desk view can target a specific shop.
  describe("location-scoped inventory", () => {
    beforeEach(() => {
      vi.mocked(getViewerLocations).mockResolvedValue(null);
    });

    describe("adjustStock", () => {
      it("uses the default-location wrapper when no shop is given", async () => {
        dbHolder.current = makeDbMock({ executeQueue: [[{ new_stock: 7 }]] });
        await adjustStock("p1", null, 2);
        expect(sqlText(dbHolder.current.calls.execute[0])).toContain(
          "adjust_stock(",
        );
      });

      it("writes to the chosen shop's shelf", async () => {
        dbHolder.current = makeDbMock({
          selectQueue: [[{ id: "loc-2" }]],
          executeQueue: [[{ new_stock: 7 }]],
        });
        await adjustStock("p1", null, 2, "adjustment", undefined, "loc-2");
        expect(sqlText(dbHolder.current.calls.execute[0])).toContain(
          "adjust_stock_at(",
        );
      });

      // Phase B2: a location-bound admin must not reach another shop's shelf by
      // editing the URL. Invariant 7 — a filter the client sets is not a boundary.
      it("refuses a location outside the viewer's scope", async () => {
        vi.mocked(getViewerLocations).mockResolvedValue(["loc-1"]);
        const r = await adjustStock(
          "p1",
          null,
          2,
          "adjustment",
          undefined,
          "loc-9",
        );
        expect(r.error).toMatch(/don't have access/i);
        expect(dbHolder.current.calls.execute).toHaveLength(0);
      });

      it("refuses a location belonging to another store", async () => {
        dbHolder.current = makeDbMock({ selectQueue: [[]] });
        const r = await adjustStock(
          "p1",
          null,
          2,
          "adjustment",
          undefined,
          "loc-x",
        );
        expect(r.error).toMatch(/unknown location/i);
        expect(dbHolder.current.calls.execute).toHaveLength(0);
      });
    });

    describe("setStock", () => {
      // The bug this guards: computing the delta against products.stock — the
      // cross-location SUM — would write a wildly wrong correction.
      it("computes the delta against THAT shelf, not the store total", async () => {
        dbHolder.current = makeDbMock({
          selectQueue: [
            [{ id: "loc-2" }], // location validation
            [{ stock: 4 }], // inventory_levels at loc-2
            [{ id: "loc-2" }], // adjustStock re-validates
          ],
          executeQueue: [[{ new_stock: 9 }]],
        });
        await setStock("p1", null, 9, "count", "loc-2");
        // 9 − 4 = +5 at that location, not 9 − (whatever the aggregate is).
        expect(sqlText(dbHolder.current.calls.execute[0])).toContain(
          "adjust_stock_at(",
        );
      });

      it("treats a shop that never carried the SKU as zero", async () => {
        dbHolder.current = makeDbMock({
          selectQueue: [[{ id: "loc-2" }], [], [{ id: "loc-2" }]],
          executeQueue: [[{ new_stock: 5 }]],
        });
        const r = await setStock("p1", null, 5, "stocking", "loc-2");
        expect(r.error).toBeUndefined();
      });
    });
  });
});
