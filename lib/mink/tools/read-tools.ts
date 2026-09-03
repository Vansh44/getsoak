import "server-only";

import { and, asc, eq, ilike, or } from "drizzle-orm";
import { getSalesAnalytics } from "@/app/dashboard/analytics/data";
import { can } from "@/app/dashboard/lib/permissions";
import { products, stores } from "@/drizzle/schema";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { withUser } from "@/lib/db/client";
import { readLowStockItems } from "@/lib/inventory/low-stock-read";
import {
  readMinkCatalogHealth,
  readMinkCatalogHealthByLocation,
} from "../catalog-health-read";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext, MinkArtifact } from "../types";
import { enqueueWeeklyTradingReport } from "../workflows";
import { resolveMinkLocation } from "./location-scope";
import { MinkToolRegistry, type MinkTool } from "./registry";
import { currentOrderTool, listOrdersTool } from "./order-tools";
import { searchHelpCentreTool } from "./help-tool";
import { minkDraftTools } from "./draft-tools";

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const getStoreProfile: MinkTool = {
  declaration: {
    name: "get_store_profile",
    description:
      "Read the current store's name, slug, operating status, and subscription plan. The store is always derived from the signed-in dashboard host.",
    parametersJsonSchema: EMPTY_OBJECT_SCHEMA,
  },
  permission: { section: "dashboard", action: "view" },
  timeoutMs: 5_000,
  async execute(actor) {
    const rows = await withActor(actor, (db) =>
      db
        .select({
          name: stores.name,
          slug: stores.slug,
          status: stores.status,
          plan: stores.plan,
        })
        .from(stores)
        .where(eq(stores.id, actor.storeId))
        .limit(1),
    );
    const store = rows[0];
    if (!store) throw new Error("Store not found");
    return store;
  },
};

const getCatalogSummary: MinkTool = {
  declaration: {
    name: "get_catalog_summary",
    description:
      "Return product-level publication counts and, when requested, sellable-SKU inventory health using the dashboard's thresholds. You MUST classify inventory_scope: publication_only when no stock fact was requested; clarify when stock was requested without an explicit all/combined, each/by-location, or named-location scope; combined only when the user explicitly asks across/all/combined locations; by_location when the user asks for each location or a comparison; location only with an exact location_name. A clarify request automatically uses the only accessible location, but returns permission-safe choices when several locations could materially differ. Never silently treat a missing location as combined stock.",
    parametersJsonSchema: {
      type: "object",
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
          description:
            "Required inventory intent. Use clarify for a vague low/out-of-stock request, not combined.",
        },
        location_name: {
          type: "string",
          description:
            "Exact accessible dashboard location name. Supply only with inventory_scope=location. Never use or invent a location ID.",
          minLength: 1,
          maxLength: 100,
        },
        limit: {
          type: "integer",
          description: "Maximum product/variant rows, from 1 to 20.",
          minimum: 1,
          maximum: 20,
          default: 20,
        },
      },
      required: ["inventory_scope"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "view" },
  timeoutMs: 7_000,
  artifact: catalogSummaryArtifact,
  async execute(actor, args) {
    const inventoryScope = readCatalogInventoryScope(args.inventory_scope);
    const inventoryAccess = can(
      actor.permissions,
      "inventory",
      "view",
      actor.isSuperadmin,
    );
    if (inventoryScope === "location" && !args.location_name) {
      throw new MinkToolInputError(
        "location_name is required when inventory_scope is location.",
      );
    }
    if (inventoryScope !== "location" && args.location_name) {
      throw new MinkToolInputError(
        "location_name may be used only when inventory_scope is location.",
      );
    }

    const location = inventoryAccess
      ? await resolveMinkLocation(
          actor,
          inventoryScope === "location" ? args.location_name : undefined,
        )
      : null;
    const identity = { uid: actor.adminId, email: actor.email };
    const dataAsOf = new Date().toISOString();

    if (
      inventoryAccess &&
      location &&
      inventoryScope === "clarify" &&
      location.availableLocations.length > 1
    ) {
      const availableLocations = location.availableLocations.slice(0, 6);
      return {
        requiresClarification: true,
        question:
          "Stock can differ by location. Which inventory scope should I use?",
        choices: [
          {
            label: "Compare locations",
            description: "See low-stock and out-of-stock counts side by side.",
            prompt:
              "Compare low-stock and out-of-stock SKU counts for each accessible location, together with the current product publication summary.",
          },
          {
            label: "Combined stock",
            description: "Use the all-accessible-location aggregate.",
            prompt:
              "Show low-stock and out-of-stock SKU counts across all accessible locations combined, together with the current product publication summary.",
          },
          ...availableLocations.slice(0, 4).map((option) => ({
            label: option.name,
            description: `Check only this ${displayLocationType(option.type)}.`,
            prompt: `Show the product publication summary and low-stock and out-of-stock SKUs at the exact dashboard location ${JSON.stringify(option.name)}.`,
          })),
        ],
        availableLocations: availableLocations.map((option) => ({
          name: option.name,
          type: option.type,
        })),
        locationsTruncated: location.availableLocations.length > 6,
        dataAsOf,
      };
    }

    if (inventoryAccess && location && inventoryScope === "by_location") {
      const comparedLocations = location.availableLocations.slice(0, 20);
      const comparison = await readMinkCatalogHealthByLocation({
        storeId: actor.storeId,
        identity,
        locationIds: comparedLocations.map((option) => option.id),
        defaultThreshold: actor.defaultLowStockThreshold,
      });
      return {
        ...comparison,
        inventoryAccess: true,
        inventoryView: "by_location",
        locationScope: "Each accessible store location",
        locationsTruncated: location.availableLocations.length > 20,
        dataAsOf,
        dashboardPath: "/dashboard/products",
      };
    }

    let effectiveLocationIds: string[] | null = [];
    let locationScope = "Inventory not requested";
    let selectedId: string | null = null;
    let includeInventory = false;
    if (inventoryAccess && location && inventoryScope !== "publication_only") {
      if (location.availableLocations.length === 0) {
        locationScope = "No accessible active locations";
      } else if (
        inventoryScope === "clarify" &&
        location.availableLocations.length === 1
      ) {
        includeInventory = true;
        effectiveLocationIds = [location.availableLocations[0].id];
        selectedId = location.availableLocations[0].id;
        locationScope = location.availableLocations[0].name;
      } else {
        includeInventory = true;
        effectiveLocationIds =
          inventoryScope === "location"
            ? location.locationIds
            : location.availableLocations.map((option) => option.id);
        selectedId = location.selectedId;
        locationScope = location.label;
      }
    } else if (!inventoryAccess) {
      locationScope = "Inventory hidden by permission";
    }

    const summary = await readMinkCatalogHealth({
      storeId: actor.storeId,
      identity,
      locationIds: effectiveLocationIds,
      defaultThreshold: actor.defaultLowStockThreshold,
      includeInventory,
      limit: readLimit(args.limit, 20),
    });
    return {
      ...summary,
      inventoryAccess,
      inventoryVisible: includeInventory,
      inventoryView: includeInventory ? "summary" : "hidden",
      locationScope,
      dataAsOf,
      inventoryDashboardPath: selectedId
        ? `/dashboard/inventory?location=${encodeURIComponent(selectedId)}`
        : "/dashboard/inventory",
      dashboardPath: "/dashboard/products",
    };
  },
};

const searchProducts: MinkTool = {
  declaration: {
    name: "search_products",
    description:
      "Find products in the current store by product name or exact/partial SKU. Returns at most 20 compact records and never returns descriptions or embedded content.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Product name or SKU to search for.",
          minLength: 1,
          maxLength: 100,
        },
        limit: {
          type: "integer",
          description: "Maximum result count, from 1 to 20.",
          minimum: 1,
          maximum: 20,
          default: 10,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "view" },
  timeoutMs: 5_000,
  artifact: productsArtifact,
  async execute(actor, args) {
    const query = readSearchQuery(args.query);
    const limit = readLimit(args.limit);
    const pattern = `%${escapeLike(query)}%`;
    const rows = await withActor(actor, (db) =>
      db
        .select({
          id: products.id,
          name: products.name,
          sku: products.sku,
          status: products.status,
          sellingPrice: products.sellingPrice,
          stock: products.stock,
          trackInventory: products.trackInventory,
        })
        .from(products)
        .where(
          and(
            eq(products.storeId, actor.storeId),
            or(ilike(products.name, pattern), ilike(products.sku, pattern)),
          ),
        )
        .orderBy(asc(products.name))
        .limit(limit),
    );
    return {
      query,
      count: rows.length,
      products: rows.map((product) => ({
        ...product,
        dashboardPath: `/dashboard/products/${product.id}`,
      })),
      dataAsOf: new Date().toISOString(),
      dashboardPath: `/dashboard/products?q=${encodeURIComponent(query)}`,
    };
  },
};

const getCurrentProduct: MinkTool = {
  declaration: {
    name: "get_current_product",
    description:
      "Read the product currently selected in the dashboard. The browser context is revalidated against the current store; this tool accepts no product ID.",
    parametersJsonSchema: EMPTY_OBJECT_SCHEMA,
  },
  permission: { section: "products", action: "view" },
  available: (actor) => actor.selectedResource?.type === "product",
  timeoutMs: 5_000,
  artifact: productsArtifact,
  async execute(actor) {
    if (actor.selectedResource?.type !== "product") {
      throw new MinkToolInputError("No product is selected in the dashboard.");
    }
    const rows = await withActor(actor, (db) =>
      db
        .select({
          id: products.id,
          name: products.name,
          sku: products.sku,
          description: products.description,
          seoTitle: products.seoTitle,
          seoDescription: products.seoDescription,
          status: products.status,
          sellingPrice: products.sellingPrice,
          stock: products.stock,
          trackInventory: products.trackInventory,
        })
        .from(products)
        .where(
          and(
            eq(products.id, actor.selectedResource!.id),
            eq(products.storeId, actor.storeId),
          ),
        )
        .limit(1),
    );
    return {
      query: "Current dashboard product",
      count: rows.length,
      products: rows.map((product) => ({
        ...product,
        ...(!actor.draftingEnabled
          ? {
              description: undefined,
              seoTitle: undefined,
              seoDescription: undefined,
            }
          : {}),
        dashboardPath: `/dashboard/products/${product.id}`,
      })),
      dataAsOf: new Date().toISOString(),
    };
  },
};

const SALES_PERIODS = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "mtd",
  "ytd",
] as const;
const SALES_COMPARISONS = ["previous", "year", "none"] as const;
const SALES_CHANNELS = ["all", "online", "pos"] as const;

const getSalesSummary: MinkTool = {
  declaration: {
    name: "get_sales_summary",
    description:
      "Read recognized net sales, order count, average order value, and units sold for a bounded dashboard period. Results use the store timezone, include completed refunds, enforce the signed-in admin's location scope, and include a dashboard link.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: [...SALES_PERIODS],
          description: "Sales period in the store timezone. Defaults to today.",
          default: "today",
        },
        comparison: {
          type: "string",
          enum: [...SALES_COMPARISONS],
          description:
            "Compare with the preceding equal period, the prior year, or no period. Defaults to previous.",
          default: "previous",
        },
        location_name: {
          type: "string",
          description:
            "Optional accessible dashboard location name. The name may include its displayed type, such as Delhi warehouse. Never use or invent a location ID.",
          minLength: 1,
          maxLength: 100,
        },
        channel: {
          type: "string",
          enum: [...SALES_CHANNELS],
          description: "All sales, online store sales, or point-of-sale sales.",
          default: "all",
        },
      },
      additionalProperties: false,
    },
  },
  permission: { section: "analytics", action: "view" },
  timeoutMs: 7_000,
  artifact: salesArtifact,
  async execute(actor, args) {
    const period = readEnum(args.period, SALES_PERIODS, "period", "today");
    const comparison = readEnum(
      args.comparison,
      SALES_COMPARISONS,
      "comparison",
      "previous",
    );
    const location = await resolveMinkLocation(actor, args.location_name);
    const channel = readEnum(args.channel, SALES_CHANNELS, "channel", "all");
    const range = parseAnalyticsRange(
      { range: period, compare: comparison },
      actor.analyticsTimeZone,
    );
    const sales = await getSalesAnalytics(
      actor.storeId,
      {
        locationIds: location.locationIds,
        selectedId: location.selectedId,
        includeUnassigned: location.includeUnassigned,
      },
      range,
      channel,
    );
    return {
      period: range.preset,
      range: {
        label: sales.rangeLabel,
        fromInclusive: range.current.from.toISOString(),
        toExclusive: range.current.to.toISOString(),
        timeZone: range.timeZone,
      },
      comparison: sales.comparisonLabel
        ? { type: range.comparison, label: sales.comparisonLabel }
        : null,
      locationScope: {
        label:
          location.includeUnassigned && !location.selectedId
            ? `${location.label} plus online or unassigned orders`
            : location.label,
        selectedLocation: location.selectedId !== null,
      },
      currency: actor.currency,
      channel,
      metrics: {
        netSales: sales.totalSales.value,
        netSalesTrendPercent: sales.totalSales.trendPct,
        orders: sales.orders.value,
        ordersTrendPercent: sales.orders.trendPct,
        averageOrderValue: sales.averageOrderValue.value,
        averageOrderValueTrendPercent: sales.averageOrderValue.trendPct,
        unitsSold: sales.unitsSold.value,
        unitsSoldTrendPercent: sales.unitsSold.trendPct,
      },
      dataAsOf: new Date().toISOString(),
      dashboardPath: `/dashboard/analytics?range=${period}&compare=${comparison}${location.selectedId ? `&location=${encodeURIComponent(location.selectedId)}` : ""}`,
    };
  },
};

const listLowStock: MinkTool = {
  declaration: {
    name: "list_low_stock",
    description:
      "List the current store's lowest-stock tracked products and variants, using their configured thresholds and the signed-in admin's exact location scope. Includes inventory and product dashboard links.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        location_name: {
          type: "string",
          description:
            "Optional accessible dashboard location name. The name may include its displayed type, such as Delhi warehouse. Never use or invent a location ID.",
          minLength: 1,
          maxLength: 100,
        },
        include_out_of_stock: {
          type: "boolean",
          description:
            "Whether zero/negative-stock items should be included. Defaults to true.",
          default: true,
        },
        limit: {
          type: "integer",
          description: "Maximum result count, from 1 to 20.",
          minimum: 1,
          maximum: 20,
          default: 10,
        },
      },
      additionalProperties: false,
    },
  },
  permission: { section: "inventory", action: "view" },
  timeoutMs: 7_000,
  artifact: inventoryArtifact,
  async execute(actor, args) {
    const location = await resolveMinkLocation(actor, args.location_name);
    const includeOutOfStock = readBoolean(
      args.include_out_of_stock,
      "include_out_of_stock",
      true,
    );
    const limit = readLimit(args.limit);
    const result = await readLowStockItems({
      storeId: actor.storeId,
      identity: { uid: actor.adminId, email: actor.email },
      locationIds: location.locationIds,
      defaultThreshold: actor.defaultLowStockThreshold,
      includeOutOfStock,
      limit,
    });
    return {
      locationScope: location.label,
      includeOutOfStock,
      count: result.items.length,
      truncated: result.truncated,
      defaultThreshold: actor.defaultLowStockThreshold,
      items: result.items.map((item) => ({
        ...item,
        productDashboardPath: `/dashboard/products/${item.productId}`,
      })),
      dataAsOf: new Date().toISOString(),
      inventoryDashboardPath: location.selectedId
        ? `/dashboard/inventory?location=${encodeURIComponent(location.selectedId)}`
        : "/dashboard/inventory",
    };
  },
};

const startWeeklyTradingReport: MinkTool = {
  declaration: {
    name: "start_weekly_trading_report",
    description:
      "Queue a durable, read-only weekly trading report only when the user explicitly asks Mink to create, run, prepare, or generate that report. It uses the signed-in admin's exact current location scope, the store timezone, the last 7 days and the preceding equal period. The workflow runs in the background, consumes no additional model tokens while queued, never mutates business records, and returns a progress card. Do not call it for an ordinary one-off sales question; use get_sales_summary instead.",
    parametersJsonSchema: EMPTY_OBJECT_SCHEMA,
  },
  permission: { section: "analytics", action: "view" },
  timeoutMs: 7_000,
  artifact(output) {
    const workflow = (output.workflow ?? {}) as Record<string, unknown>;
    return {
      type: "workflow",
      runId: String(workflow.id ?? ""),
      template: "weekly_trading_report",
      title: "Weekly trading report",
      description:
        "A durable 7-day sales report compared with the previous period.",
      status: (workflow.status ?? "queued") as Extract<
        MinkArtifact,
        { type: "workflow" }
      >["status"],
      currentStep: Number(workflow.currentStep ?? 0),
      totalSteps: Number(workflow.totalSteps ?? 3),
    };
  },
  async execute(actor) {
    const workflow = await enqueueWeeklyTradingReport(actor);
    return { workflow };
  },
};

function catalogSummaryArtifact(output: Record<string, unknown>): MinkArtifact {
  if (output.requiresClarification === true) {
    const choices = Array.isArray(output.choices)
      ? (output.choices as Array<Record<string, unknown>>)
      : [];
    return {
      type: "clarification",
      title: "Choose inventory scope",
      question: String(
        output.question ?? "Which inventory scope should I use?",
      ),
      choices: choices.slice(0, 6).map((choice) => ({
        label: String(choice.label ?? "Choose"),
        description:
          typeof choice.description === "string"
            ? choice.description
            : undefined,
        prompt: String(choice.prompt ?? ""),
      })),
    };
  }
  const items = Array.isArray(output.items)
    ? (output.items as Array<Record<string, unknown>>)
    : [];
  return {
    type: "catalog",
    title: "Catalogue & inventory",
    counts: {
      total: Number(output.total ?? 0),
      published: Number(output.published ?? 0),
      unpublished: Number(output.unpublished ?? 0),
      draft: Number(output.draft ?? 0),
      archived: Number(output.archived ?? 0),
      inventoryItems:
        output.inventoryItems == null
          ? null
          : Number(output.inventoryItems ?? 0),
      lowStock: output.lowStock == null ? null : Number(output.lowStock ?? 0),
      outOfStock:
        output.outOfStock == null ? null : Number(output.outOfStock ?? 0),
    },
    items: items.map((item) => ({
      id: String(item.id ?? item.variantId ?? item.productId ?? ""),
      title: String(item.productName ?? "Product"),
      variant:
        typeof item.variantName === "string" ? item.variantName : undefined,
      sku: String(item.sku ?? "No SKU"),
      publicationStatus: String(item.publicationStatus ?? "draft"),
      publicationTags: Array.isArray(item.publicationTags)
        ? item.publicationTags.map(String).slice(0, 2)
        : [],
      inventoryStatus:
        typeof item.inventoryStatus === "string" ? item.inventoryStatus : null,
      stock: item.stock == null ? null : Number(item.stock),
      threshold: item.threshold == null ? null : Number(item.threshold),
      dashboardPath:
        typeof item.dashboardPath === "string" ? item.dashboardPath : undefined,
    })),
    locations: Array.isArray(output.locations)
      ? (output.locations as Array<Record<string, unknown>>).map(
          (location) => ({
            id: String(location.id ?? ""),
            name: String(location.name ?? "Location"),
            type: String(location.type ?? "location"),
            inventoryItems: Number(location.inventoryItems ?? 0),
            trackedItems: Number(location.trackedItems ?? 0),
            lowStock: Number(location.lowStock ?? 0),
            outOfStock: Number(location.outOfStock ?? 0),
            dashboardPath:
              typeof location.dashboardPath === "string"
                ? location.dashboardPath
                : undefined,
            prompt: `Show the product publication summary and low-stock and out-of-stock SKUs at the exact dashboard location ${JSON.stringify(String(location.name ?? "Location"))}.`,
          }),
        )
      : undefined,
    filters: [
      { label: "Publication", value: "Current store" },
      ...(output.locationScope === "Inventory not requested"
        ? []
        : [
            {
              label: "Inventory",
              value: String(output.locationScope ?? "Hidden"),
            },
          ]),
    ],
    dataAsOf: typeof output.dataAsOf === "string" ? output.dataAsOf : undefined,
    dashboardPath:
      typeof output.dashboardPath === "string"
        ? output.dashboardPath
        : undefined,
    inventoryDashboardPath:
      output.inventoryVisible === true &&
      typeof output.inventoryDashboardPath === "string"
        ? output.inventoryDashboardPath
        : undefined,
    truncated: output.truncated === true,
    locationsTruncated: output.locationsTruncated === true,
  };
}

type CatalogInventoryScope =
  | "publication_only"
  | "clarify"
  | "combined"
  | "by_location"
  | "location";

function readCatalogInventoryScope(value: unknown): CatalogInventoryScope {
  if (
    value === "publication_only" ||
    value === "clarify" ||
    value === "combined" ||
    value === "by_location" ||
    value === "location"
  ) {
    return value;
  }
  throw new MinkToolInputError(
    "inventory_scope must classify the request as publication_only, clarify, combined, by_location, or location.",
  );
}

function displayLocationType(value: string): string {
  return value.replaceAll("_", " ").toLocaleLowerCase("en-IN");
}

function productsArtifact(output: Record<string, unknown>): MinkArtifact {
  const rows = Array.isArray(output.products)
    ? (output.products as Array<Record<string, unknown>>)
    : [];
  return {
    type: "records",
    title: "Products",
    recordType: "product",
    records: rows.map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.name ?? "Product"),
      subtitle: String(row.sku ?? "No SKU"),
      value:
        row.sellingPrice == null
          ? undefined
          : `INR ${Number(row.sellingPrice).toLocaleString("en-IN")}`,
      status: String(row.status ?? ""),
      dashboardPath:
        typeof row.dashboardPath === "string" ? row.dashboardPath : undefined,
    })),
    filters: [{ label: "Search", value: String(output.query ?? "Selected") }],
    dataAsOf: typeof output.dataAsOf === "string" ? output.dataAsOf : undefined,
    dashboardPath:
      typeof output.dashboardPath === "string"
        ? output.dashboardPath
        : undefined,
  };
}

function salesArtifact(output: Record<string, unknown>): MinkArtifact {
  const metrics = (output.metrics ?? {}) as Record<string, unknown>;
  const range = (output.range ?? {}) as Record<string, unknown>;
  const location = (output.locationScope ?? {}) as Record<string, unknown>;
  return {
    type: "metrics",
    title: "Sales summary",
    currency: String(output.currency ?? "INR"),
    metrics: [
      ["Net sales", metrics.netSales, "currency", metrics.netSalesTrendPercent],
      ["Orders", metrics.orders, "number", metrics.ordersTrendPercent],
      [
        "Average order value",
        metrics.averageOrderValue,
        "currency",
        metrics.averageOrderValueTrendPercent,
      ],
      [
        "Units sold",
        metrics.unitsSold,
        "number",
        metrics.unitsSoldTrendPercent,
      ],
    ].map(([label, value, format, trendPercent]) => ({
      label: String(label),
      value: Number(value ?? 0),
      format: format as "number" | "currency",
      trendPercent: trendPercent == null ? null : Number(trendPercent),
    })),
    filters: [
      { label: "Period", value: String(range.label ?? output.period ?? "") },
      { label: "Location", value: String(location.label ?? "Store") },
      { label: "Channel", value: String(output.channel ?? "all") },
      { label: "Timezone", value: String(range.timeZone ?? "") },
    ],
    dataAsOf: typeof output.dataAsOf === "string" ? output.dataAsOf : undefined,
    dashboardPath:
      typeof output.dashboardPath === "string"
        ? output.dashboardPath
        : undefined,
  };
}

function inventoryArtifact(output: Record<string, unknown>): MinkArtifact {
  const items = Array.isArray(output.items)
    ? (output.items as Array<Record<string, unknown>>)
    : [];
  return {
    type: "records",
    title: "Low-stock inventory",
    recordType: "inventory",
    records: items.map((item) => ({
      id: String(item.variantId ?? item.productId ?? ""),
      title: [item.productName, item.variantName].filter(Boolean).join(" — "),
      subtitle: `${String(item.sku ?? "No SKU")} · threshold ${Number(item.threshold ?? 0)}`,
      value: `${Number(item.stock ?? 0)} in stock`,
      status: String(item.status ?? "low"),
      dashboardPath:
        typeof item.productDashboardPath === "string"
          ? item.productDashboardPath
          : undefined,
    })),
    filters: [
      { label: "Location", value: String(output.locationScope ?? "Store") },
      {
        label: "Includes out of stock",
        value: output.includeOutOfStock === false ? "No" : "Yes",
      },
    ],
    dataAsOf: typeof output.dataAsOf === "string" ? output.dataAsOf : undefined,
    dashboardPath:
      typeof output.inventoryDashboardPath === "string"
        ? output.inventoryDashboardPath
        : undefined,
    truncated: output.truncated === true,
  };
}

function withActor<T>(
  actor: MinkActorContext,
  fn: Parameters<typeof withUser<T>>[1],
): Promise<T> {
  return withUser({ uid: actor.adminId, email: actor.email }, fn);
}

function readSearchQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new MinkToolInputError("query must be a string.");
  }
  const query = value.trim();
  if (!query || query.length > 100) {
    throw new MinkToolInputError("query must be between 1 and 100 characters.");
  }
  return query;
}

function readLimit(value: unknown, fallback = 10): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20) {
    throw new MinkToolInputError("limit must be an integer from 1 to 20.");
  }
  return Number(value);
}

function readBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new MinkToolInputError(`${field} must be a boolean.`);
  }
  return value;
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  fallback: T[number],
): T[number] {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new MinkToolInputError(
      `${field} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T[number];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export const minkReadToolRegistry = new MinkToolRegistry([
  getStoreProfile,
  getCatalogSummary,
  searchProducts,
  getCurrentProduct,
  getSalesSummary,
  listLowStock,
  startWeeklyTradingReport,
  listOrdersTool,
  currentOrderTool,
  searchHelpCentreTool,
  ...minkDraftTools,
]);
