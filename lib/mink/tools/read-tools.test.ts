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

  it("exposes proposal tools only behind drafting opt-in, manage permission, and context", () => {
    const names = (overrides: Partial<MinkActorContext>) =>
      minkReadToolRegistry
        .declarationsFor({ ...ACTOR, isSuperadmin: false, ...overrides })
        .map((tool) => tool.name);

    expect(
      names({
        draftingEnabled: false,
        permissions: {
          products: ["manage"],
          blogs: ["manage"],
          marketing: ["manage"],
          users: ["manage"],
        },
      }).filter((name) => name.startsWith("propose_")),
    ).toEqual([]);

    expect(
      names({
        draftingEnabled: true,
        selectedResource: {
          type: "product",
          id: "11111111-1111-4111-8111-111111111111",
        },
        permissions: {
          products: ["manage"],
          blogs: ["manage"],
          marketing: ["manage"],
          users: ["manage"],
        },
      }).filter((name) => name.startsWith("propose_")),
    ).toEqual([
      "propose_current_product_description",
      "propose_current_product_seo",
      "propose_blog_draft",
      "propose_coupon_email",
      "propose_customer_message",
      "propose_product_create",
      "propose_coupon_create",
      "propose_coupon_update",
      "propose_customer_group_create",
      "propose_customer_group_update",
    ]);

    const marketingTools = names({
      draftingEnabled: true,
      permissions: { marketing: ["view", "manage"] },
    });
    expect(marketingTools.indexOf("get_coupon_for_draft")).toBeGreaterThan(-1);
    expect(marketingTools.indexOf("get_coupon_for_draft")).toBeLessThan(
      marketingTools.indexOf("propose_coupon_email"),
    );
    const couponReader = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { marketing: ["view", "manage"] },
      })
      .find((tool) => tool.name === "get_coupon_for_draft");
    expect(couponReader?.parametersJsonSchema).toMatchObject({
      required: ["coupon_code"],
      additionalProperties: false,
    });
    const customerTools = names({
      draftingEnabled: true,
      permissions: { users: ["view", "manage"] },
    });
    expect(
      customerTools.indexOf("get_customer_group_for_draft"),
    ).toBeGreaterThan(-1);
    expect(customerTools.indexOf("get_customer_group_for_draft")).toBeLessThan(
      customerTools.indexOf("propose_customer_group_update"),
    );
    const freeCustomerTools = names({
      draftingEnabled: true,
      effectivePlan: "free",
      permissions: { users: ["view", "manage"] },
    });
    expect(freeCustomerTools).not.toContain("propose_customer_group_create");
    expect(freeCustomerTools).toContain("propose_customer_group_update");
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
