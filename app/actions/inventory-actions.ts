"use server";

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  categories,
  productVariants,
  products,
  stockMovements,
  stores,
} from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { DASHBOARD_PAGE_SIZE } from "@/app/dashboard/lib/list-params";
import { TAGS } from "@/lib/storefront/tags";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { inventoryStatus } from "@/lib/inventory/status";

export interface SkuRow {
  id: string; // "p-uuid" or "v-uuid"
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  sku: string | null;
  stock: number;
  trackInventory: boolean;
  lowStockThreshold: number | null;
  allowBackorder: boolean;
  status: "in" | "low" | "out" | "untracked";
  category: string | null;
  image: string | null;
}

export type InventoryFilter = "all" | "low" | "out";

export interface StockMovementRow {
  id: string;
  delta: number;
  reason: string;
  balance_after: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
  order_id: string | null;
}

export async function getInventory({
  page = 1,
  pageSize = DASHBOARD_PAGE_SIZE,
  filter = "all",
  q = "",
  categoryId,
}: {
  page?: number;
  pageSize?: number;
  filter?: InventoryFilter;
  q?: string;
  categoryId?: string;
}): Promise<{
  rows: SkuRow[];
  total: number;
  lowStockThreshold: number;
  error?: string;
}> {
  const userId = await getManagerUserId("inventory");
  if (!userId)
    return {
      rows: [],
      total: 0,
      lowStockThreshold: 5,
      error: "Not authenticated",
    };

  const storeId = await getActingStoreId();

  // The store's default low-stock threshold.
  let defaultLowThreshold = 5;
  try {
    const storeRows = await withService((db) =>
      db
        .select({ settings: stores.settings, plan: stores.plan })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    const settings = resolveStoreSettings(
      storeRows[0]?.settings as Record<string, unknown>,
      storeRows[0]?.plan,
    );
    defaultLowThreshold =
      (settings["inventory.lowStockThreshold"] as number) ?? 5;
  } catch (err) {
    console.error("getInventory settings:", err);
  }

  // We need to fetch simple products (products without variants) and product
  // variants. Instead of a SQL UNION, we fetch both, combine in memory, sort
  // and paginate. This is safe since we have the category filter. For very
  // large stores this might need a custom RPC or materialized view, but this
  // matches the Phase 1 scope. Aliased snake_case selects keep the rows in the
  // shape lib/inventory/status.ts expects.
  const prodConds = [eq(products.storeId, storeId)];
  const varConds = [eq(productVariants.storeId, storeId)];
  if (categoryId && categoryId !== "all") {
    prodConds.push(eq(products.categoryId, categoryId));
    varConds.push(eq(products.categoryId, categoryId));
  }

  let productRows: {
    id: string;
    name: string;
    sku: string | null;
    stock: number;
    track_inventory: boolean;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
    image_url: string | null;
    images: string[] | null;
    category: string | null;
  }[];
  let variantRows: {
    id: string;
    product_id: string;
    name: string;
    sku: string | null;
    stock: number;
    track_inventory: boolean;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
    image_url: string | null;
    images: string[] | null;
    product_name: string;
    product_image: string | null;
    category: string | null;
  }[];
  try {
    [productRows, variantRows] = await withService(async (db) => {
      const productRows = await db
        .select({
          id: products.id,
          name: products.name,
          sku: products.sku,
          stock: products.stock,
          track_inventory: products.trackInventory,
          low_stock_threshold: products.lowStockThreshold,
          allow_backorder: products.allowBackorder,
          image_url: products.imageUrl,
          images: products.images,
          category: categories.name,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(and(...prodConds));
      const variantRows = await db
        .select({
          id: productVariants.id,
          product_id: productVariants.productId,
          name: productVariants.name,
          sku: productVariants.sku,
          stock: productVariants.stock,
          track_inventory: productVariants.trackInventory,
          low_stock_threshold: productVariants.lowStockThreshold,
          allow_backorder: productVariants.allowBackorder,
          image_url: productVariants.imageUrl,
          images: productVariants.images,
          product_name: products.name,
          product_image: products.imageUrl,
          category: categories.name,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(and(...varConds));
      return [productRows, variantRows] as const;
    });
  } catch (err) {
    console.error("getInventory:", err);
    return {
      rows: [],
      total: 0,
      lowStockThreshold: defaultLowThreshold,
      error: dbErrorMessage(err, "Failed to load inventory."),
    };
  }

  // Identify simple products by finding products that have no variants
  const variantProductIds = new Set(variantRows.map((v) => v.product_id));
  const simpleProducts = productRows.filter(
    (p) => !variantProductIds.has(p.id),
  );

  let allRows: SkuRow[] = [];

  for (const p of simpleProducts) {
    const status = inventoryStatus(p, defaultLowThreshold);

    allRows.push({
      id: `p-${p.id}`,
      productId: p.id,
      variantId: null,
      name: p.name,
      variantName: null,
      sku: p.sku,
      stock: p.stock,
      trackInventory: p.track_inventory,
      lowStockThreshold: p.low_stock_threshold,
      allowBackorder: p.allow_backorder,
      status,
      category: p.category ?? null,
      image: p.image_url ?? p.images?.[0] ?? null,
    });
  }

  for (const v of variantRows) {
    const status = inventoryStatus(v, defaultLowThreshold);

    allRows.push({
      id: `v-${v.id}`,
      productId: v.product_id,
      variantId: v.id,
      name: v.product_name,
      variantName: v.name,
      sku: v.sku,
      stock: v.stock,
      trackInventory: v.track_inventory,
      lowStockThreshold: v.low_stock_threshold,
      allowBackorder: v.allow_backorder,
      category: v.category ?? null,
      image: v.image_url ?? v.images?.[0] ?? v.product_image ?? null,
      status,
    });
  }

  // Search — in-memory match on product name, variant name, or SKU. Safe for
  // any punctuation the merchant uses in names, and this action already
  // fetches every row for the store and paginates in memory.
  const term = q.trim().toLowerCase().slice(0, 200);
  if (term) {
    allRows = allRows.filter(
      (r) =>
        r.name.toLowerCase().includes(term) ||
        (r.variantName?.toLowerCase().includes(term) ?? false) ||
        (r.sku?.toLowerCase().includes(term) ?? false),
    );
  }

  // Status filter
  if (filter === "low") allRows = allRows.filter((r) => r.status === "low");
  if (filter === "out") allRows = allRows.filter((r) => r.status === "out");

  // Sort: stock ASC (lowest first), then name
  allRows.sort((a, b) => {
    if (a.stock !== b.stock) return a.stock - b.stock;
    return a.name.localeCompare(b.name);
  });

  const total = allRows.length;
  const p = page || 1;
  const start = (p - 1) * pageSize;
  const rows = allRows.slice(start, start + pageSize);

  return { rows, total, lowStockThreshold: defaultLowThreshold };
}

export async function adjustStock(
  productId: string,
  variantId: string | null | undefined,
  delta: number,
  reason: string = "adjustment",
  note?: string,
): Promise<{ success?: boolean; newStock?: number; error?: string }> {
  const userId = await getManagerUserId("inventory");
  if (!userId) return { error: "Not authenticated" };

  const storeId = await getActingStoreId();

  try {
    // The unchanged Postgres function does the atomic, row-locked adjustment
    // and writes the ledger row.
    const res = await withService((db) =>
      db.execute(
        sql`select adjust_stock(p_store => ${storeId}, p_product => ${productId}, p_variant => ${variantId || null}, p_delta => ${delta}, p_reason => ${reason}, p_note => ${note || null}, p_actor => ${userId}) as new_stock`,
      ),
    );
    revalidateTag(TAGS.products, "max");
    const row = res.rows[0] as { new_stock: number | string } | undefined;

    emitEvent({
      type: "inventory.adjusted",
      storeId,
      actor: { type: "admin", id: userId },
      subject: { type: "product", id: variantId || productId },
      payload: {
        delta,
        stock: Number(row?.new_stock),
        reason,
        ...(note ? { note } : {}),
      },
    });
    reportStockChanges(storeId, [{ productId, variantId, delta }]);

    return { success: true, newStock: Number(row?.new_stock) };
  } catch (err) {
    return { error: dbErrorMessage(err, "Failed to adjust stock.") };
  }
}

export async function setStock(
  productId: string,
  variantId: string | null | undefined,
  quantity: number,
  note?: string,
): Promise<{ success?: boolean; newStock?: number; error?: string }> {
  const userId = await getManagerUserId("inventory");
  if (!userId) return { error: "Not authenticated" };

  const storeId = await getActingStoreId();

  // First fetch current stock to compute delta
  let row: { stock: number } | undefined;
  try {
    const rows = await withService((db) =>
      variantId
        ? db
            .select({ stock: productVariants.stock })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.id, variantId),
                eq(productVariants.storeId, storeId),
              ),
            )
            .limit(1)
        : db
            .select({ stock: products.stock })
            .from(products)
            .where(
              and(eq(products.id, productId), eq(products.storeId, storeId)),
            )
            .limit(1),
    );
    row = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Failed to read current stock.") };
  }
  if (!row) return { error: "SKU not found." };

  const currentStock = row.stock;
  const delta = quantity - currentStock;

  if (delta === 0) return { success: true, newStock: currentStock };

  return adjustStock(productId, variantId, delta, "correction", note);
}

// Guard against an unbounded fan-out of concurrent RPCs (the UI only ever sends
// the selected visible rows, ≤ one page).
const MAX_BULK_ITEMS = 500;

export async function bulkAdjust(
  items: {
    productId: string;
    variantId?: string;
    delta?: number;
    set?: number;
  }[],
): Promise<{ success?: boolean; error?: string }> {
  const userId = await getManagerUserId("inventory");
  if (!userId) return { error: "Not authenticated" };
  if (items.length === 0) return { success: true };
  if (items.length > MAX_BULK_ITEMS) return { error: "Too many items." };

  const storeId = await getActingStoreId();

  // "Set" items need each SKU's current balance to compute a delta. Batch-read
  // them in ONE query per table instead of a round-trip per item.
  const setItems = items.filter((i) => i.set !== undefined);
  const currentStock = new Map<string, number>(); // key: variantId || productId
  if (setItems.length > 0) {
    const productIds = setItems
      .filter((i) => !i.variantId)
      .map((i) => i.productId);
    const variantIds = setItems
      .filter((i) => i.variantId)
      .map((i) => i.variantId!);
    try {
      const [prodRows, varRows] = await withService(async (db) => {
        const prodRows = await (productIds.length
          ? db
              .select({ id: products.id, stock: products.stock })
              .from(products)
              .where(
                and(
                  eq(products.storeId, storeId),
                  inArray(products.id, productIds),
                ),
              )
          : Promise.resolve([]));
        const varRows = await (variantIds.length
          ? db
              .select({
                id: productVariants.id,
                stock: productVariants.stock,
              })
              .from(productVariants)
              .where(
                and(
                  eq(productVariants.storeId, storeId),
                  inArray(productVariants.id, variantIds),
                ),
              )
          : Promise.resolve([]));
        return [prodRows, varRows] as const;
      });
      for (const r of prodRows) currentStock.set(r.id, r.stock);
      for (const r of varRows) currentStock.set(r.id, r.stock);
    } catch (err) {
      return { error: dbErrorMessage(err, "Failed to read current stock.") };
    }
  }

  // Resolve each item to a concrete delta, skipping no-ops and unknown SKUs.
  const ops: { item: (typeof items)[number]; delta: number; reason: string }[] =
    [];
  for (const item of items) {
    if (item.set !== undefined) {
      const current = currentStock.get(item.variantId || item.productId);
      if (current === undefined) continue; // not found / not this store
      const delta = item.set - current;
      if (delta !== 0) ops.push({ item, delta, reason: "correction" });
    } else if (item.delta !== undefined && item.delta !== 0) {
      ops.push({ item, delta: item.delta, reason: "adjustment" });
    }
  }

  if (ops.length === 0) return { success: true };

  // Fire the atomic RPCs concurrently (each is an independent, row-locked
  // UPDATE on a distinct SKU) rather than sequentially.
  const results = await Promise.all(
    ops.map((op) =>
      withService((db) =>
        db.execute(
          sql`select adjust_stock(p_store => ${storeId}, p_product => ${op.item.productId}, p_variant => ${op.item.variantId || null}, p_delta => ${op.delta}, p_reason => ${op.reason}, p_note => ${"Bulk update"}, p_actor => ${userId})`,
        ),
      ).then(
        () => null,
        (err) => err as unknown,
      ),
    ),
  );

  // Bust the shared product cache ONCE for the whole batch, not per item. Some
  // ops may have succeeded even if one failed, so revalidate regardless.
  revalidateTag(TAGS.products, "max");

  reportStockChanges(
    storeId,
    ops
      .filter((_, i) => results[i] === null)
      .map((op) => ({
        productId: op.item.productId,
        variantId: op.item.variantId || null,
        delta: op.delta,
      })),
  );

  const failed = results.find((r) => r !== null);
  if (failed) return { error: dbErrorMessage(failed, "Some updates failed.") };
  return { success: true };
}

export async function getMovements(
  productId: string,
  variantId?: string | null,
  page: number = 1,
): Promise<{ movements: StockMovementRow[]; total: number; error?: string }> {
  const userId = await getManagerUserId("inventory");
  if (!userId) return { movements: [], total: 0, error: "Not authenticated" };

  const storeId = await getActingStoreId();

  const conds = [
    eq(stockMovements.storeId, storeId),
    eq(stockMovements.productId, productId),
  ];
  if (variantId) {
    conds.push(eq(stockMovements.variantId, variantId));
  } else if (variantId === null) {
    conds.push(isNull(stockMovements.variantId));
  }
  const whereExpr = and(...conds);

  const p = page || 1;
  const pageSize = DASHBOARD_PAGE_SIZE;
  const start = (p - 1) * pageSize;

  try {
    const { rows, total } = await withService(async (db) => {
      const rows = await db
        .select({
          id: stockMovements.id,
          delta: stockMovements.delta,
          reason: stockMovements.reason,
          balance_after: stockMovements.balanceAfter,
          note: stockMovements.note,
          created_by: stockMovements.createdBy,
          created_at: stockMovements.createdAt,
          order_id: stockMovements.orderId,
        })
        .from(stockMovements)
        .where(whereExpr)
        .orderBy(desc(stockMovements.createdAt))
        .limit(pageSize)
        .offset(start);
      const countRows = await db
        .select({ n: count() })
        .from(stockMovements)
        .where(whereExpr);
      return { rows, total: countRows[0]?.n ?? 0 };
    });
    return { movements: rows as StockMovementRow[], total };
  } catch (err) {
    return {
      movements: [],
      total: 0,
      error: dbErrorMessage(err, "Failed to load stock history."),
    };
  }
}
