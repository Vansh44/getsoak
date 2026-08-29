import { describe, expect, it } from "vitest";
import type { MinkActorContext } from "../types";
import { minkReadToolRegistry } from "./read-tools";

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
};

describe("Mink read-tool declarations", () => {
  it("never lets the model provide a tenant or actor identifier", () => {
    const declarations = minkReadToolRegistry.declarationsFor(ACTOR);

    expect(declarations.map((tool) => tool.name)).toEqual([
      "get_store_profile",
      "get_catalog_summary",
      "search_products",
      "get_sales_summary",
      "list_low_stock",
      "list_orders",
      "search_help_centre",
    ]);
    for (const declaration of declarations) {
      const properties = declaration.parametersJsonSchema.properties as
        | Record<string, unknown>
        | undefined;
      expect(properties).not.toHaveProperty("storeId");
      expect(properties).not.toHaveProperty("store_id");
      expect(properties).not.toHaveProperty("adminId");
      expect(properties).not.toHaveProperty("permissions");
    }
  });

  it("exposes each business tool only with its trusted section permission", () => {
    const declared = (permissions: MinkActorContext["permissions"]) =>
      minkReadToolRegistry
        .declarationsFor({ ...ACTOR, isSuperadmin: false, permissions })
        .map((tool) => tool.name);

    expect(declared({ dashboard: ["view"] })).toEqual([
      "get_store_profile",
      "search_help_centre",
    ]);
    expect(declared({ dashboard: ["view"], products: ["view"] })).toEqual([
      "get_store_profile",
      "get_catalog_summary",
      "search_products",
      "search_help_centre",
    ]);
    expect(declared({ dashboard: ["view"], analytics: ["view"] })).toEqual([
      "get_store_profile",
      "get_sales_summary",
      "search_help_centre",
    ]);
    expect(declared({ dashboard: ["view"], inventory: ["view"] })).toEqual([
      "get_store_profile",
      "list_low_stock",
      "search_help_centre",
    ]);
    expect(declared({ dashboard: ["view"], orders: ["view"] })).toEqual([
      "get_store_profile",
      "list_orders",
      "search_help_centre",
    ]);
  });

  it("rejects direct calls to every hidden business tool before data access", async () => {
    const restricted: MinkActorContext = {
      ...ACTOR,
      isSuperadmin: false,
      permissions: { dashboard: ["view"] },
    };
    for (const name of [
      "get_catalog_summary",
      "search_products",
      "get_sales_summary",
      "list_low_stock",
      "list_orders",
    ]) {
      await expect(
        minkReadToolRegistry.execute(restricted, { name, args: {} }),
      ).resolves.toMatchObject({
        response: { error: { code: "permission_denied" } },
      });
    }
  });
});
