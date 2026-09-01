import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveMinkBulkInventoryTargets } from "./bulk-inventory-targets";
import type { MinkActorContext } from "./types";

const actor = {
  storeId: "11111111-1111-4111-8111-111111111111",
  adminId: "admin-1",
  locationIds: ["22222222-2222-4222-8222-222222222222"],
} as MinkActorContext;

function database(levels: unknown[] = []) {
  const where = vi.fn(async () => levels);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const execute = vi.fn();
  return { db: { execute, select }, execute, select, where };
}

describe("Phase 5B bulk inventory target resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves up to 20 lines with three candidate reads and one level read", async () => {
    const { db, execute, select } = database([
      {
        id: "55555555-5555-4555-8555-555555555555",
        productId: "33333333-3333-4333-8333-333333333333",
        variantId: null,
        locationId: "22222222-2222-4222-8222-222222222222",
        onHand: 12,
        reserved: 3,
        version: "2026-08-31T12:00:00.123456+00:00",
      },
    ]);
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Delhi",
            match_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: "33333333-3333-4333-8333-333333333333",
            product_name: "Tea",
            sku: "TEA",
            product_tracked: true,
            has_variants: false,
            match_count: 1,
          },
          {
            product_id: "44444444-4444-4444-8444-444444444444",
            product_name: "Loose stock",
            sku: "LOOSE",
            product_tracked: false,
            has_variants: false,
            match_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveMinkBulkInventoryTargets(db as never, actor, [
      { sku: "TEA", locationName: "Delhi" },
      { sku: "MISSING", locationName: "Delhi" },
      { sku: "LOOSE", locationName: "Delhi" },
    ]);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(select).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({
      line: 1,
      error: null,
      target: { sku: "TEA", onHand: 12, reserved: 3 },
    });
    expect(result[1]).toMatchObject({
      line: 2,
      error: { code: "sku_not_found" },
    });
    expect(result[2]).toMatchObject({
      line: 3,
      error: { code: "tracking_disabled" },
    });
  });

  it("marks every repeated SKU/location line and skips the level read", async () => {
    const { db, execute, select } = database();
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Delhi",
            match_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: "33333333-3333-4333-8333-333333333333",
            product_name: "Tea",
            sku: "TEA",
            product_tracked: true,
            has_variants: false,
            match_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveMinkBulkInventoryTargets(db as never, actor, [
      { sku: "TEA", locationName: "Delhi" },
      { sku: "TEA", locationName: "Delhi" },
    ]);

    expect(result.map((line) => line.error?.code)).toEqual([
      "duplicate_line",
      "duplicate_line",
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(select).not.toHaveBeenCalled();
  });

  it("fails closed when the actor has no accessible locations", async () => {
    const { db, execute, select } = database();
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await resolveMinkBulkInventoryTargets(
      db as never,
      { ...actor, locationIds: [] },
      [{ sku: "TEA", locationName: "Delhi" }],
    );

    expect(result[0]).toMatchObject({
      error: { code: "location_unavailable" },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
  });
});
