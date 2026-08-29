import "server-only";

import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { products, stores } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext } from "../types";
import { MinkToolRegistry, type MinkTool } from "./registry";

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
      "Return compact counts for the current store's products: total, published, draft, archived, out of stock, and low stock. Use this for catalog-health questions.",
    parametersJsonSchema: EMPTY_OBJECT_SCHEMA,
  },
  permission: { section: "products", action: "view" },
  async execute(actor) {
    const rows = await withActor(actor, (db) =>
      db
        .select({
          total: sql<number>`count(*)::int`,
          published: sql<number>`count(*) filter (where ${products.status} = 'published')::int`,
          draft: sql<number>`count(*) filter (where ${products.status} = 'draft')::int`,
          archived: sql<number>`count(*) filter (where ${products.status} = 'archived')::int`,
          outOfStock: sql<number>`count(*) filter (where ${products.trackInventory} and ${products.stock} <= 0)::int`,
          lowStock: sql<number>`count(*) filter (where ${products.trackInventory} and ${products.stock} > 0 and ${products.lowStockThreshold} is not null and ${products.stock} <= ${products.lowStockThreshold})::int`,
        })
        .from(products)
        .where(eq(products.storeId, actor.storeId)),
    );
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      published: Number(row?.published ?? 0),
      draft: Number(row?.draft ?? 0),
      archived: Number(row?.archived ?? 0),
      outOfStock: Number(row?.outOfStock ?? 0),
      lowStock: Number(row?.lowStock ?? 0),
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
    return { query, count: rows.length, products: rows };
  },
};

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

function readLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20) {
    throw new MinkToolInputError("limit must be an integer from 1 to 20.");
  }
  return Number(value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export const minkReadToolRegistry = new MinkToolRegistry([
  getStoreProfile,
  getCatalogSummary,
  searchProducts,
]);
