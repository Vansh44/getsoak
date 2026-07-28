/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlText } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSettings: vi.fn(async () => ({ "inventory.lowStockThreshold": 5 })),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/inventory/alerts", () => ({ reportStockChanges: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { reportStockChanges } from "@/lib/inventory/alerts";
import {
  adjustPosStock,
  countPosStock,
  getPosInventory,
  getTransferTargets,
  transferPosStock,
} from "./pos-inventory-actions";

const LOC_B = "c0000000-0000-4000-8000-00000000000c";

const actor = (role: "cashier" | "manager" | "owner") => ({
  role,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: role === "owner" ? null : "st1",
  name: role === "owner" ? "Owner" : "Priya",
  source: role === "owner" ? ("owner" as const) : ("operator" as const),
  deviceAuthorized: true,
});

const row = (over: any = {}) => ({
  product_id: "p1",
  variant_id: null,
  name: "Toned Milk",
  variant_name: null,
  p_sku: "SKU1",
  v_sku: null,
  p_barcode: "890",
  v_barcode: null,
  p_image: null,
  v_image: null,
  p_track: true,
  v_track: null,
  p_low: null,
  v_low: null,
  on_hand: 12,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(actor("manager") as any);
  dbHolder.current = makeDbMock();
});

describe("getPosInventory", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await getPosInventory()).error).toMatch(/signed in/i);
  });

  // A cashier sells stock; they do not get to see or declare how much exists.
  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    expect((await getPosInventory()).error).toMatch(/not allowed/i);
  });

  it("reports on-hand at the operator's location", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[row()]] });
    const r = await getPosInventory();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ productId: "p1", onHand: 12 });
  });

  // The whole point of a per-location screen: the join must be on THIS shop.
  it("scopes the level join to the operator's location", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[row()]] });
    await getPosInventory();
    expect(sqlText(dbHolder.current.calls.where[0])).toContain("=");
  });

  it("treats a missing level row as zero, not as absent", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[row({ on_hand: null })]] });
    expect((await getPosInventory()).items[0].onHand).toBe(0);
  });

  // Nothing to count on an untracked SKU; listing them makes a stocktake noisy.
  it("omits untracked SKUs", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[row({ p_track: false }), row({ product_id: "p2" })]],
    });
    const r = await getPosInventory();
    expect(r.items.map((i) => i.productId)).toEqual(["p2"]);
  });

  it("flags low stock against the store default", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [row({ on_hand: 3 }), row({ product_id: "p2", on_hand: 9 })],
      ],
    });
    const r = await getPosInventory();
    expect(r.items[0].low).toBe(true); // 3 <= 5
    expect(r.items[1].low).toBe(false); // 9 > 5
  });

  it("prefers a per-SKU threshold over the store default", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[row({ on_hand: 9, p_low: 10 })]],
    });
    expect((await getPosInventory()).items[0].low).toBe(true);
  });

  it("filters to low stock on request", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [row({ on_hand: 3 }), row({ product_id: "p2", on_hand: 9 })],
      ],
    });
    const r = await getPosInventory({ lowOnly: true });
    expect(r.items.map((i) => i.productId)).toEqual(["p1"]);
  });
});

describe("adjustPosStock", () => {
  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    const r = await adjustPosStock("p1", null, 5);
    expect(r.error).toMatch(/manager or the owner/i);
  });

  it("adjusts at the operator's location and reports the new stock", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ new_stock: 17 }]] });
    const r = await adjustPosStock("p1", null, 5, "received", "  delivery  ");
    expect(r).toMatchObject({ success: true, newStock: 17 });
    const q = sqlText(dbHolder.current.calls.execute[0]);
    expect(q).toContain("adjust_stock_at");
  });

  // Threshold alerts fire on the CROSSING, not the state (§22) — the adjust
  // path has to feed them or a manual correction to zero alerts nobody.
  it("reports the change for low-stock alerts", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ new_stock: 0 }]] });
    await adjustPosStock("p1", "v1", -4);
    expect(reportStockChanges).toHaveBeenCalledWith("store-1", [
      { productId: "p1", variantId: "v1", delta: -4 },
    ]);
  });

  it("rejects a zero, fractional or absurd delta", async () => {
    expect((await adjustPosStock("p1", null, 0)).error).toMatch(/valid/i);
    expect((await adjustPosStock("p1", null, 1.5)).error).toMatch(/valid/i);
    expect((await adjustPosStock("p1", null, 9e9)).error).toMatch(/valid/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });
});

describe("countPosStock", () => {
  const seedCurrent = (onHand: number, newStock = 0) =>
    (dbHolder.current = makeDbMock({
      selectQueue: [[{ on_hand: onHand }]],
      executeQueue: [[{ new_stock: newStock }]],
    }));

  // A count is stored as a DELTA so it goes through the same atomic RPC and
  // leaves the same ledger trail as any other correction.
  it("turns a count into the delta that reaches it", async () => {
    seedCurrent(12, 9);
    const r = await countPosStock("p1", null, 9);
    expect(r).toMatchObject({ success: true, newStock: 9 });
    expect(reportStockChanges).toHaveBeenCalledWith("store-1", [
      { productId: "p1", variantId: null, delta: -3 },
    ]);
  });

  it("counts upward too", async () => {
    seedCurrent(2, 6);
    await countPosStock("p1", null, 6);
    expect(reportStockChanges).toHaveBeenCalledWith("store-1", [
      { productId: "p1", variantId: null, delta: 4 },
    ]);
  });

  // No movement means no ledger row — a stocktake that confirms the figure
  // should not litter the history with zero-delta entries.
  it("writes nothing when the count already matches", async () => {
    seedCurrent(12);
    const r = await countPosStock("p1", null, 12);
    expect(r).toMatchObject({ success: true, newStock: 12 });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects a negative or fractional count", async () => {
    expect((await countPosStock("p1", null, -1)).error).toMatch(/valid count/i);
    expect((await countPosStock("p1", null, 2.5)).error).toMatch(
      /valid count/i,
    );
  });
});

describe("transferPosStock", () => {
  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    const r = await transferPosStock("p1", null, 3, LOC_B);
    expect(r.error).toMatch(/manager or the owner/i);
  });

  it("sends stock from THIS location to the chosen one", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ ok: true }]] });
    const r = await transferPosStock("p1", null, 3, LOC_B, "restock");
    expect(r.success).toBe(true);
    expect(sqlText(dbHolder.current.calls.execute[0])).toContain(
      "transfer_stock",
    );
  });

  // The RPC returns false for insufficient stock; that must surface as a
  // refusal, not a silent success.
  it("surfaces a refusal from the RPC", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ ok: false }]] });
    const r = await transferPosStock("p1", null, 999, LOC_B);
    expect(r.error).toMatch(/not enough stock/i);
    expect(r.success).toBeUndefined();
  });

  it("refuses sending to this same shop", async () => {
    const r = await transferPosStock("p1", null, 3, "loc-1");
    expect(r.error).toMatch(/this shop/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects a bad quantity or a missing destination", async () => {
    expect((await transferPosStock("p1", null, 0, LOC_B)).error).toMatch(
      /valid quantity/i,
    );
    expect((await transferPosStock("p1", null, -3, LOC_B)).error).toMatch(
      /valid quantity/i,
    );
    expect((await transferPosStock("p1", null, 3, "")).error).toMatch(
      /where to send/i,
    );
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("counts the source's loss for low-stock alerts", async () => {
    dbHolder.current = makeDbMock({ executeQueue: [[{ ok: true }]] });
    await transferPosStock("p1", "v1", 4, LOC_B);
    expect(reportStockChanges).toHaveBeenCalledWith("store-1", [
      { productId: "p1", variantId: "v1", delta: -4 },
    ]);
  });
});

describe("getTransferTargets", () => {
  it("excludes the operator's own location", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          { id: "loc-1", name: "Main" },
          { id: LOC_B, name: "Second shop" },
        ],
      ],
    });
    const r = await getTransferTargets();
    expect(r.targets).toEqual([{ id: LOC_B, name: "Second shop" }]);
  });

  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    expect((await getTransferTargets()).error).toMatch(/manager or the owner/i);
  });
});
