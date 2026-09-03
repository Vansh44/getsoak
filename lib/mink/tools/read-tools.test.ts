import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "../types";

const mocks = vi.hoisted(() => ({
  readCatalog: vi.fn(),
  readByLocation: vi.fn(),
  resolveLocation: vi.fn(),
  enqueueWorkflow: vi.fn(),
  enqueueRevenueWorkflow: vi.fn(),
  enqueueLaunchWorkflow: vi.fn(),
}));
vi.mock("../catalog-health-read", () => ({
  readMinkCatalogHealth: mocks.readCatalog,
  readMinkCatalogHealthByLocation: mocks.readByLocation,
}));
vi.mock("./location-scope", () => ({
  resolveMinkLocation: mocks.resolveLocation,
}));
vi.mock("../workflows", () => ({
  enqueueWeeklyTradingReport: mocks.enqueueWorkflow,
  enqueueRevenueDeclineInvestigation: mocks.enqueueRevenueWorkflow,
  enqueueProductLaunchPreparation: mocks.enqueueLaunchWorkflow,
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveLocation.mockResolvedValue({
    locationIds: null,
    selectedId: null,
    label: "All store locations",
    includeUnassigned: true,
    availableLocations: [
      { id: "shop-1", name: "Shop", type: "shop" },
      { id: "delhi-1", name: "Delhi", type: "warehouse" },
    ],
  });
  mocks.readCatalog.mockResolvedValue({
    total: 14,
    published: 14,
    unpublished: 0,
    draft: 0,
    archived: 0,
    inventoryItems: 16,
    lowStock: 1,
    outOfStock: 0,
    items: [],
    truncated: false,
  });
  mocks.enqueueWorkflow.mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    template: "weekly_trading_report",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
  mocks.enqueueRevenueWorkflow.mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    template: "revenue_decline_investigation",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
  mocks.enqueueLaunchWorkflow.mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    template: "product_launch_preparation",
    status: "queued",
    currentStep: 0,
    totalSteps: 3,
  });
});

describe("Mink read-tool declarations", () => {
  it("never lets the model provide a tenant or actor identifier", () => {
    const declarations = minkReadToolRegistry.declarationsFor(ACTOR);

    expect(declarations.map((tool) => tool.name)).toEqual([
      "get_store_profile",
      "get_catalog_summary",
      "search_products",
      "get_sales_summary",
      "list_low_stock",
      "start_weekly_trading_report",
      "start_revenue_decline_investigation",
      "start_product_launch_preparation",
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
    const catalog = declarations.find(
      (tool) => tool.name === "get_catalog_summary",
    );
    expect(catalog?.parametersJsonSchema).toMatchObject({
      additionalProperties: false,
      required: ["inventory_scope"],
      properties: {
        inventory_scope: {
          type: "string",
          enum: [
            "publication_only",
            "clarify",
            "combined",
            "by_location",
            "location",
          ],
        },
        location_name: { type: "string", maxLength: 100 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 20 },
      },
    });
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
      "start_weekly_trading_report",
      "start_revenue_decline_investigation",
      "search_help_centre",
    ]);
    expect(declared({ dashboard: ["view"], inventory: ["view"] })).toEqual([
      "get_store_profile",
      "list_low_stock",
      "search_help_centre",
    ]);
    expect(
      declared({
        dashboard: ["view"],
        products: ["view"],
        inventory: ["view"],
      }),
    ).toEqual([
      "get_store_profile",
      "get_catalog_summary",
      "search_products",
      "list_low_stock",
      "start_product_launch_preparation",
      "search_help_centre",
    ]);
    expect(declared({ dashboard: ["view"], orders: ["view"] })).toEqual([
      "get_store_profile",
      "list_orders",
      "search_help_centre",
    ]);
  });

  it("queues bounded Phase 6B and 6C workflows through permission-gated tools", async () => {
    const actor = { ...ACTOR, runId: "run-1" };
    const revenue = await minkReadToolRegistry.execute(actor, {
      id: "call-revenue",
      name: "start_revenue_decline_investigation",
      args: { period: "30d", location_name: "Shop" },
    });
    expect(mocks.enqueueRevenueWorkflow).toHaveBeenCalledWith(actor, {
      period: "30d",
      locationName: "Shop",
    });
    expect(revenue.artifact).toMatchObject({
      type: "workflow",
      template: "revenue_decline_investigation",
      runId: "22222222-2222-4222-8222-222222222222",
    });

    const launch = await minkReadToolRegistry.execute(actor, {
      id: "call-launch",
      name: "start_product_launch_preparation",
      args: { product_sku: "SKU10010007V028" },
    });
    expect(mocks.enqueueLaunchWorkflow).toHaveBeenCalledWith(actor, {
      productSku: "SKU10010007V028",
    });
    expect(launch.artifact).toMatchObject({
      type: "workflow",
      template: "product_launch_preparation",
      runId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("queues the durable report only through its Analytics-gated tool", async () => {
    const actor = { ...ACTOR, runId: "run-1" };
    const result = await minkReadToolRegistry.execute(actor, {
      id: "call-workflow",
      name: "start_weekly_trading_report",
      args: {},
    });

    expect(mocks.enqueueWorkflow).toHaveBeenCalledWith(actor);
    expect(result.response.output).toMatchObject({
      workflow: { status: "queued", totalSteps: 3 },
    });
    expect(result.artifact).toEqual({
      type: "workflow",
      runId: "11111111-1111-4111-8111-111111111111",
      template: "weekly_trading_report",
      title: "Weekly trading report",
      description:
        "A durable 7-day sales report compared with the previous period.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    });
  });

  it("returns bounded scope choices instead of silently aggregating a vague multi-location stock request", async () => {
    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-1",
      name: "get_catalog_summary",
      args: { inventory_scope: "clarify" },
    });

    expect(mocks.readCatalog).not.toHaveBeenCalled();
    expect(mocks.readByLocation).not.toHaveBeenCalled();
    expect(result.response.output).toMatchObject({
      requiresClarification: true,
      question: expect.stringContaining("Which inventory scope"),
      choices: expect.arrayContaining([
        expect.objectContaining({ label: "Compare locations" }),
        expect.objectContaining({ label: "Combined stock" }),
        expect.objectContaining({ label: "Shop" }),
        expect.objectContaining({ label: "Delhi" }),
      ]),
    });
    expect(result.artifact).toMatchObject({
      type: "clarification",
      choices: expect.arrayContaining([
        expect.objectContaining({ label: "Compare locations" }),
      ]),
    });
  });

  it("automatically uses the only accessible location for a vague stock request", async () => {
    mocks.resolveLocation.mockResolvedValue({
      locationIds: ["shop-1"],
      selectedId: null,
      label: "1 assigned location",
      includeUnassigned: true,
      availableLocations: [{ id: "shop-1", name: "Shop", type: "shop" }],
    });

    await minkReadToolRegistry.execute(ACTOR, {
      id: "call-2",
      name: "get_catalog_summary",
      args: { inventory_scope: "clarify", limit: 10 },
    });

    expect(mocks.readCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        locationIds: ["shop-1"],
        includeInventory: true,
        limit: 10,
      }),
    );
  });

  it("compares only trusted accessible location ids for an explicit by-location request", async () => {
    mocks.readByLocation.mockResolvedValue({
      total: 14,
      published: 14,
      unpublished: 0,
      draft: 0,
      archived: 0,
      inventoryItems: 16,
      trackedItems: 9,
      locations: [
        {
          id: "shop-1",
          name: "Shop",
          type: "shop",
          inventoryItems: 16,
          trackedItems: 9,
          lowStock: 1,
          outOfStock: 2,
          dashboardPath: "/dashboard/inventory?location=shop-1",
        },
      ],
    });

    const result = await minkReadToolRegistry.execute(ACTOR, {
      id: "call-3",
      name: "get_catalog_summary",
      args: { inventory_scope: "by_location" },
    });

    expect(mocks.readByLocation).toHaveBeenCalledWith(
      expect.objectContaining({ locationIds: ["shop-1", "delhi-1"] }),
    );
    expect(result.artifact).toMatchObject({
      type: "catalog",
      locations: [
        expect.objectContaining({
          name: "Shop",
          lowStock: 1,
          outOfStock: 2,
        }),
      ],
    });
  });

  it("builds an explicit combined total from active accessible locations only", async () => {
    await minkReadToolRegistry.execute(ACTOR, {
      id: "call-4",
      name: "get_catalog_summary",
      args: { inventory_scope: "combined" },
    });

    expect(mocks.readCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        locationIds: ["shop-1", "delhi-1"],
        includeInventory: true,
      }),
    );
  });

  it("never resolves or exposes location choices without Inventory View", async () => {
    const result = await minkReadToolRegistry.execute(
      {
        ...ACTOR,
        isSuperadmin: false,
        permissions: { products: ["view"] },
      },
      {
        id: "call-5",
        name: "get_catalog_summary",
        args: { inventory_scope: "clarify" },
      },
    );

    expect(mocks.resolveLocation).not.toHaveBeenCalled();
    expect(mocks.readCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ includeInventory: false, locationIds: [] }),
    );
    expect(result.response.output).toMatchObject({
      inventoryAccess: false,
      inventoryVisible: false,
      locationScope: "Inventory hidden by permission",
    });
    expect(result.artifact?.type).toBe("catalog");
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
      "propose_bulk_price_update",
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

    const inventoryTools = names({
      draftingEnabled: true,
      permissions: { inventory: ["view", "manage"] },
    });
    expect(inventoryTools).toEqual([
      "list_low_stock",
      "get_inventory_item_for_adjustment",
      "propose_inventory_adjustment",
      "get_inventory_items_for_bulk_adjustment",
      "propose_bulk_inventory_adjustment",
    ]);
    const proposal = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { inventory: ["view", "manage"] },
      })
      .find((tool) => tool.name === "propose_inventory_adjustment");
    expect(proposal?.parametersJsonSchema).toMatchObject({
      required: expect.arrayContaining([
        "product_sku",
        "location_name",
        "inventory_snapshot",
        "reason",
      ]),
      additionalProperties: false,
    });
    expect(proposal?.parametersJsonSchema.properties).not.toHaveProperty(
      "product_id",
    );
    expect(proposal?.parametersJsonSchema.properties).not.toHaveProperty(
      "location_id",
    );
    expect(proposal?.parametersJsonSchema.properties).toHaveProperty(
      "quantity_change",
    );
    expect(proposal?.parametersJsonSchema.properties).toHaveProperty(
      "target_quantity",
    );
    const bulkReader = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { inventory: ["view", "manage"] },
      })
      .find((tool) => tool.name === "get_inventory_items_for_bulk_adjustment");
    const bulkProposal = minkReadToolRegistry
      .declarationsFor({
        ...ACTOR,
        isSuperadmin: false,
        draftingEnabled: true,
        permissions: { inventory: ["view", "manage"] },
      })
      .find((tool) => tool.name === "propose_bulk_inventory_adjustment");
    expect(bulkReader?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: {
        lines: { minItems: 1, maxItems: 20 },
      },
    });
    expect(bulkProposal?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: {
        lines: { minItems: 1, maxItems: 20 },
      },
    });
    const bulkItems = (
      bulkProposal?.parametersJsonSchema.properties as {
        lines?: { items?: { properties?: Record<string, unknown> } };
      }
    )?.lines?.items?.properties;
    expect(bulkItems).not.toHaveProperty("product_id");
    expect(bulkItems).not.toHaveProperty("location_id");
    expect(bulkItems).toHaveProperty("inventory_snapshot");

    const productTools = minkReadToolRegistry.declarationsFor({
      ...ACTOR,
      isSuperadmin: false,
      draftingEnabled: true,
      permissions: { products: ["view", "manage"] },
    });
    const bulkPriceReader = productTools.find(
      (tool) => tool.name === "get_products_for_bulk_price_update",
    );
    const bulkPriceProposal = productTools.find(
      (tool) => tool.name === "propose_bulk_price_update",
    );
    expect(bulkPriceReader?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: { lines: { minItems: 1, maxItems: 20 } },
    });
    expect(bulkPriceProposal?.parametersJsonSchema).toMatchObject({
      required: ["lines"],
      additionalProperties: false,
      properties: { lines: { minItems: 1, maxItems: 20 } },
    });
    const bulkPriceItems = (
      bulkPriceProposal?.parametersJsonSchema.properties as {
        lines?: { items?: { properties?: Record<string, unknown> } };
      }
    )?.lines?.items?.properties;
    expect(bulkPriceItems).not.toHaveProperty("product_id");
    expect(bulkPriceItems).not.toHaveProperty("variant_id");
    expect(bulkPriceItems).toHaveProperty("price_snapshot");
    expect(bulkPriceItems).toHaveProperty("special_price_mode");
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
      "start_weekly_trading_report",
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
