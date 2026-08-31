import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { withUser } from "@/lib/db/client";
import {
  readMinkCatalogHealth,
  readMinkCatalogHealthByLocation,
} from "./catalog-health-read";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: unknown, run: (db: unknown) => unknown) =>
    run({ execute }),
  ),
}));

describe("readMinkCatalogHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes product publication and SKU stock statuses with a hard result bound", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          total: 2,
          published: 1,
          unpublished: 1,
          draft: 1,
          archived: 0,
          inventory_items: 3,
          low_stock: 1,
          out_of_stock: 1,
          items: [
            {
              product_id: "product-1",
              variant_id: "variant-1",
              product_name: "Cobalt Lounge Chair",
              variant_name: "Bone",
              sku: "SKU-BONE",
              publication_status: "published",
              stock: 0,
              threshold: 5,
              inventory_status: "out",
            },
            {
              product_id: "product-2",
              variant_id: null,
              product_name: "Draft lamp",
              variant_name: null,
              sku: "SKU-LAMP",
              publication_status: "draft",
              stock: 4,
              threshold: 5,
              inventory_status: "low",
            },
          ],
        },
      ],
    });

    const result = await readMinkCatalogHealth({
      storeId: "store-1",
      identity: { uid: "admin-1", email: "owner@example.com" },
      locationIds: ["shop-1"],
      defaultThreshold: 5,
      includeInventory: true,
      limit: 1,
    });

    expect(withUser).toHaveBeenCalledWith(
      { uid: "admin-1", email: "owner@example.com" },
      expect.any(Function),
    );
    expect(result).toMatchObject({
      total: 2,
      published: 1,
      unpublished: 1,
      draft: 1,
      lowStock: 1,
      outOfStock: 1,
      truncated: true,
      items: [
        {
          id: "variant-1",
          publicationTags: ["published"],
          inventoryStatus: "out",
          stock: 0,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
    });
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.sql).not.toContain("store-1");
    expect(compiled.sql).not.toContain("shop-1");
    expect(compiled.params).toContain("store-1");
    expect(compiled.params).toContain("shop-1");
    expect(compiled.sql).toContain("not exists");
    expect(compiled.sql).toContain("product_variants");
  });

  it("keeps inventory counts and fields unavailable when stock is not authorized", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          total: 1,
          published: 0,
          unpublished: 1,
          draft: 0,
          archived: 1,
          inventory_items: null,
          low_stock: null,
          out_of_stock: null,
          items: [
            {
              product_id: "product-1",
              variant_id: null,
              product_name: "Old product",
              sku: "SKU-OLD",
              publication_status: "archived",
              stock: null,
              threshold: null,
              inventory_status: null,
            },
          ],
        },
      ],
    });

    const result = await readMinkCatalogHealth({
      storeId: "store-1",
      identity: { uid: "admin-1", email: null },
      locationIds: [],
      defaultThreshold: 5,
      includeInventory: false,
      limit: 20,
    });

    expect(result.lowStock).toBeNull();
    expect(result.outOfStock).toBeNull();
    expect(result.items[0]).toMatchObject({
      publicationTags: ["unpublished", "archived"],
      inventoryStatus: null,
      stock: null,
    });
  });

  it("returns bounded per-location health while treating missing tracked shelf rows as out of stock", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          total: 14,
          published: 14,
          unpublished: 0,
          draft: 0,
          archived: 0,
          inventory_items: 16,
          tracked_items: 9,
          locations: [
            {
              id: "shop-1",
              name: "Shop",
              type: "shop",
              inventory_items: 16,
              tracked_items: 9,
              low_stock: 1,
              out_of_stock: 2,
            },
            {
              id: "warehouse-1",
              name: "Delhi",
              type: "warehouse",
              inventory_items: 16,
              tracked_items: 9,
              low_stock: 0,
              out_of_stock: 6,
            },
          ],
        },
      ],
    });

    const result = await readMinkCatalogHealthByLocation({
      storeId: "store-1",
      identity: { uid: "admin-1", email: "owner@example.com" },
      locationIds: ["shop-1", "warehouse-1"],
      defaultThreshold: 5,
    });

    expect(result).toMatchObject({
      total: 14,
      inventoryItems: 16,
      trackedItems: 9,
      locations: [
        {
          name: "Shop",
          lowStock: 1,
          outOfStock: 2,
          dashboardPath: "/dashboard/inventory?location=shop-1",
        },
        {
          name: "Delhi",
          lowStock: 0,
          outOfStock: 6,
          dashboardPath: "/dashboard/inventory?location=warehouse-1",
        },
      ],
    });
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.sql).toContain("counts.tracked_items");
    expect(compiled.sql).toContain("count(levels.product_id)");
    expect(compiled.sql).not.toContain("shop-1");
    expect(compiled.params).toContain("shop-1");
    expect(compiled.params).toContain("warehouse-1");
  });
});
