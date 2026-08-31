import "server-only";

import { and, asc, eq, ilike, or } from "drizzle-orm";
import { getSalesAnalytics } from "@/app/dashboard/analytics/data";
import { can } from "@/app/dashboard/lib/permissions";
import { products, stores } from "@/drizzle/schema";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { withUser } from "@/lib/db/client";
import { readLowStockItems } from "@/lib/inventory/low-stock-read";
import { readMinkCatalogHealth } from "../catalog-health-read";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext, MinkArtifact } from "../types";
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
      "Return product-level publication counts and a bounded product/variant list tagged published, unpublished, draft, archived, in stock, low stock, out of stock, or untracked. Inventory counts use the same sellable-SKU and threshold rules as the dashboard. If location_name is supplied they describe only that accessible shelf; otherwise they describe the actor's trusted all/assigned-location scope. Stock is omitted without Inventory View permission.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        location_name: {
          type: "string",
          description:
            "Optional accessible dashboard location name. Use it whenever the user asks about a named shop or warehouse. Never use or invent a location ID.",
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
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "view" },
  timeoutMs: 7_000,
  artifact: catalogSummaryArtifact,
  async execute(actor, args) {
    const inventoryAccess = can(
      actor.permissions,
      "inventory",
      "view",
      actor.isSuperadmin,
    );
    const location = inventoryAccess
      ? await resolveMinkLocation(actor, args.location_name)
      : null;
    const summary = await readMinkCatalogHealth({
      storeId: actor.storeId,
      identity: { uid: actor.adminId, email: actor.email },
      locationIds: location ? location.locationIds : [],
      defaultThreshold: actor.defaultLowStockThreshold,
      includeInventory: inventoryAccess,
      limit: readLimit(args.limit, 20),
    });
    return {
      ...summary,
      inventoryAccess,
      locationScope: location?.label ?? "Inventory hidden by permission",
      dataAsOf: new Date().toISOString(),
      inventoryDashboardPath: location?.selectedId
        ? `/dashboard/inventory?location=${encodeURIComponent(location.selectedId)}`
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

function catalogSummaryArtifact(output: Record<string, unknown>): MinkArtifact {
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
    filters: [
      { label: "Publication", value: "Current store" },
      { label: "Inventory", value: String(output.locationScope ?? "Hidden") },
    ],
    dataAsOf: typeof output.dataAsOf === "string" ? output.dataAsOf : undefined,
    dashboardPath:
      typeof output.dashboardPath === "string"
        ? output.dashboardPath
        : undefined,
    inventoryDashboardPath:
      output.inventoryAccess === true &&
      typeof output.inventoryDashboardPath === "string"
        ? output.inventoryDashboardPath
        : undefined,
    truncated: output.truncated === true,
  };
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
  listOrdersTool,
  currentOrderTool,
  searchHelpCentreTool,
  ...minkDraftTools,
]);
