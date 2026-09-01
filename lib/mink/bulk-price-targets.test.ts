import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolveMinkBulkPriceTargets } from "./bulk-price-targets";
import type { MinkActorContext } from "./types";

const actor = {
  storeId: "11111111-1111-4111-8111-111111111111",
  adminId: "admin-1",
} as MinkActorContext;

describe("Phase 5F bulk price target resolution", () => {
  it("uses two bounded tenant reads and resolves products and variants", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: "22222222-2222-4222-8222-222222222222",
            product_name: "Tea",
            sku: "TEA",
            slug: "tea",
            publication_status: "published",
            product_version: "2026-09-01T10:00:00.123Z",
            base_price: "100.00",
            selling_price: "90.00",
            has_variants: false,
            match_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: "33333333-3333-4333-8333-333333333333",
            product_name: "Coffee",
            variant_id: "44444444-4444-4444-8444-444444444444",
            variant_name: "500 g",
            sku: "COFFEE-500",
            slug: "coffee",
            publication_status: "draft",
            product_version: "2026-09-01T10:00:00.123Z",
            base_price: "250.00",
            selling_price: "225.00",
            special_price: "200.00",
            match_count: 1,
          },
        ],
      });
    const result = await resolveMinkBulkPriceTargets(
      { execute } as never,
      actor,
      [{ sku: "TEA" }, { sku: "COFFEE-500" }, { sku: "MISSING" }],
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result[0]).toMatchObject({
      target: {
        sku: "TEA",
        effectivePrice: "90.00",
        supportsSpecialPrice: false,
      },
    });
    expect(result[1]).toMatchObject({
      target: {
        sku: "COFFEE-500",
        variantName: "500 g",
        effectivePrice: "200.00",
        supportsSpecialPrice: true,
      },
    });
    expect(result[2]).toMatchObject({ error: { code: "sku_not_found" } });
  });

  it("rejects duplicate lines and a parent SKU with variants", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: "22222222-2222-4222-8222-222222222222",
            product_name: "Tea",
            sku: "TEA",
            slug: "tea",
            publication_status: "published",
            product_version: "2026-09-01T10:00:00.123Z",
            base_price: "100.00",
            selling_price: "90.00",
            has_variants: true,
            match_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const result = await resolveMinkBulkPriceTargets(
      { execute } as never,
      actor,
      [{ sku: "TEA" }, { sku: "TEA" }],
    );
    expect(result.map((line) => line.error?.code)).toEqual([
      "duplicate_line",
      "duplicate_line",
    ]);

    execute.mockClear();
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            product_id: "22222222-2222-4222-8222-222222222222",
            product_name: "Tea",
            sku: "TEA",
            slug: "tea",
            publication_status: "published",
            product_version: "2026-09-01T10:00:00.123Z",
            base_price: "100.00",
            selling_price: "90.00",
            has_variants: true,
            match_count: 1,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const parent = await resolveMinkBulkPriceTargets(
      { execute } as never,
      actor,
      [{ sku: "TEA" }],
    );
    expect(parent[0]).toMatchObject({ error: { code: "variant_required" } });
  });
});
