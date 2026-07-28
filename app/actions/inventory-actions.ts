"use server";

import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  categories,
  inventoryLevels,
  productVariants,
  products,
  stockMovements,
  storeLocations,
  stores,
} from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { DASHBOARD_PAGE_SIZE } from "@/app/dashboard/lib/list-params";
import { TAGS } from "@/lib/storefront/tags";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { inventoryStatus } from "@/lib/inventory/status";
import { getViewerLocations } from "@/lib/locations/scope";

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

/**
 * Validate a requested location for the desk view.
 *
 * Returns null for "all locations" — the aggregate, read-only. Anything else
 * must belong to THIS store and be inside the viewer's own scope (Phase B2), so
 * a location-bound admin cannot read or edit another shop's shelves by editing
 * the URL. Invariant 7: a filter the client can set is not a boundary.
 */
async function resolveInventoryLocation(
  storeId: string,
  requested: string | null | undefined,
): Promise<{ locationId: string | null; error?: string }> {
  if (!requested || requested === "all") return { locationId: null };

  const scope = await getViewerLocations();
  if (scope !== null && !scope.includes(requested)) {
    return {
      locationId: null,
      error: "You don't have access to that location.",
    };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({ id: storeLocations.id })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.id, requested),
            eq(storeLocations.storeId, storeId),
          ),
        )
        .limit(1),
    );
    if (rows.length === 0)
      return { locationId: null, error: "Unknown location." };
    return { locationId: requested };
  } catch {
    // A lookup failure falls back to the aggregate rather than editing the
    // wrong shelf.
    return { locationId: null };
  }
}

export async function getInventory({
  page = 1,
  pageSize = DASHBOARD_PAGE_SIZE,
  filter = "all",
  q = "",
  categoryId,
  locationId,
}: {
  page?: number;
  pageSize?: number;
  filter?: InventoryFilter;
  q?: string;
  categoryId?: string;
  /** A specific shop, or null/"all" for the cross-location total. */
  locationId?: string | null;
}): Promise<{
  rows: SkuRow[];
  total: number;
  lowStockThreshold: number;
  /** Echoed back so the UI knows which shelf it is actually showing. */
  locationId: string | null;
  error?: string;
}> {
  const userId = await getManagerUserId("inventory");
  if (!userId)
    return {
      rows: [],
      total: 0,
      lowStockThreshold: 5,
      locationId: null,
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
  // A specific shop shows ITS shelf; "all locations" keeps products.stock,
  // which the sync trigger maintains as the sum across every location.
  const resolved = await resolveInventoryLocation(storeId, locationId);
  const atLocation = resolved.locationId;

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
          // coalesce: a location that has never carried this SKU has no level
          // row, which means zero here — not "unknown".
          stock: atLocation
            ? sql<number>`coalesce(${inventoryLevels.onHand}, 0)`
            : products.stock,
          track_inventory: products.trackInventory,
          low_stock_threshold: products.lowStockThreshold,
          allow_backorder: products.allowBackorder,
          image_url: products.imageUrl,
          images: products.images,
          category: categories.name,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .leftJoin(
          inventoryLevels,
          atLocation
            ? and(
                eq(inventoryLevels.productId, products.id),
                eq(inventoryLevels.locationId, atLocation),
                isNull(inventoryLevels.variantId),
              )
            : sql`false`,
        )
        .where(and(...prodConds));
      const variantRows = await db
        .select({
          id: productVariants.id,
          product_id: productVariants.productId,
          name: productVariants.name,
          sku: productVariants.sku,
          stock: atLocation
            ? sql<number>`coalesce(${inventoryLevels.onHand}, 0)`
            : productVariants.stock,
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
        .leftJoin(
          inventoryLevels,
          atLocation
            ? and(
                eq(inventoryLevels.variantId, productVariants.id),
                eq(inventoryLevels.locationId, atLocation),
              )
            : sql`false`,
        )
        .where(and(...varConds));
      return [productRows, variantRows] as const;
    });
  } catch (err) {
    console.error("getInventory:", err);
    return {
      rows: [],
      total: 0,
      lowStockThreshold: defaultLowThreshold,
      locationId: null,
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

  return {
    rows,
    total,
    lowStockThreshold: defaultLowThreshold,
    locationId: atLocation,
    error: resolved.error,
  };
}

export async function adjustStock(
  productId: string,
  variantId: string | null | undefined,
  delta: number,
  reason: string = "adjustment",
  note?: string,
  /** Which shelf. Omitted = the store's default location, via the
   *  compatibility wrapper — exactly what a single-location store has always
   *  done, so nothing changes for them. */
  locationId?: string | null,
): Promise<{ success?: boolean; newStock?: number; error?: string }> {
  const userId = await getManagerUserId("inventory");
  if (!userId) return { error: "Not authenticated" };

  const storeId = await getActingStoreId();

  const resolved = await resolveInventoryLocation(storeId, locationId);
  if (resolved.error) return { error: resolved.error };
  const at = resolved.locationId;

  try {
    // The unchanged Postgres function does the atomic, row-locked adjustment
    // and writes the ledger row.
    const res = await withService((db) =>
      db.execute(
        at
          ? sql`select adjust_stock_at(p_store => ${storeId}, p_location => ${at}, p_product => ${productId}, p_variant => ${variantId || null}, p_delta => ${delta}, p_reason => ${reason}, p_note => ${note || null}, p_actor => ${userId}) as new_stock`
          : sql`select adjust_stock(p_store => ${storeId}, p_product => ${productId}, p_variant => ${variantId || null}, p_delta => ${delta}, p_reason => ${reason}, p_note => ${note || null}, p_actor => ${userId}) as new_stock`,
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
  locationId?: string | null,
): Promise<{ success?: boolean; newStock?: number; error?: string }> {
  const userId = await getManagerUserId("inventory");
  if (!userId) return { error: "Not authenticated" };

  const storeId = await getActingStoreId();

  const resolved = await resolveInventoryLocation(storeId, locationId);
  if (resolved.error) return { error: resolved.error };
  const at = resolved.locationId;

  // Current stock, to compute the delta. When a shop is selected this MUST be
  // that shelf's on_hand, not the cross-location aggregate — otherwise
  // "set Delhi to 9" would compute its delta against the company-wide total
  // and write a wildly wrong correction.
  let row: { stock: number } | undefined;
  try {
    const rows = await withService((db) => {
      if (at) {
        return db
          .select({ stock: inventoryLevels.onHand })
          .from(inventoryLevels)
          .where(
            and(
              eq(inventoryLevels.storeId, storeId),
              eq(inventoryLevels.locationId, at),
              eq(inventoryLevels.productId, productId),
              variantId
                ? eq(inventoryLevels.variantId, variantId)
                : isNull(inventoryLevels.variantId),
            ),
          )
          .limit(1);
      }
      return variantId
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
            .limit(1);
    });
    // A shop that has never carried this SKU has no level row: that is zero,
    // not "not found".
    row = rows[0] ?? (at ? { stock: 0 } : undefined);
  } catch (err) {
    return { error: dbErrorMessage(err, "Failed to read current stock.") };
  }
  if (!row) return { error: "SKU not found." };

  const currentStock = row.stock;
  const delta = quantity - currentStock;

  if (delta === 0) return { success: true, newStock: currentStock };

  return adjustStock(productId, variantId, delta, "correction", note, at);
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
  locationId?: string | null,
): Promise<{ success?: boolean; error?: string }> {
  const userId = await getManagerUserId("inventory");
  if (!userId) return { error: "Not authenticated" };
  if (items.length === 0) return { success: true };
  if (items.length > MAX_BULK_ITEMS) return { error: "Too many items." };

  const storeId = await getActingStoreId();

  const resolvedBulk = await resolveInventoryLocation(storeId, locationId);
  if (resolvedBulk.error) return { error: resolvedBulk.error };
  const at = resolvedBulk.locationId;

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
        // When a shop is selected the baseline MUST be that shelf's on_hand.
        // Reading products.stock here would compute "set Delhi to 9" against
        // the cross-location total and write a wildly wrong correction.
        if (at) {
          const levelRows = await db
            .select({
              product_id: inventoryLevels.productId,
              variant_id: inventoryLevels.variantId,
              stock: inventoryLevels.onHand,
            })
            .from(inventoryLevels)
            .where(
              and(
                eq(inventoryLevels.storeId, storeId),
                eq(inventoryLevels.locationId, at),
              ),
            );
          return [levelRows, [] as typeof levelRows] as const;
        }
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
      if (at) {
        // Keyed the same way the caller looks them up: variantId || productId.
        for (const r of prodRows as unknown as Array<{
          product_id: string;
          variant_id: string | null;
          stock: number;
        }>) {
          currentStock.set(r.variant_id ?? r.product_id, r.stock);
        }
        // A shop that has never carried a SKU has no level row; the delta
        // computation below treats a missing key as zero when `at` is set.
      } else {
        for (const r of prodRows as Array<{ id: string; stock: number }>)
          currentStock.set(r.id, r.stock);
        for (const r of varRows as Array<{ id: string; stock: number }>)
          currentStock.set(r.id, r.stock);
      }
    } catch (err) {
      return { error: dbErrorMessage(err, "Failed to read current stock.") };
    }
  }

  // Resolve each item to a concrete delta, skipping no-ops and unknown SKUs.
  const ops: { item: (typeof items)[number]; delta: number; reason: string }[] =
    [];
  for (const item of items) {
    if (item.set !== undefined) {
      const known = currentStock.get(item.variantId || item.productId);
      // At a specific shop, "no level row" means the shelf holds zero — not
      // "unknown". Skipping it would make "set to 5" silently do nothing for a
      // SKU that location has never carried, which is the common case when
      // stocking a new shop.
      const current = known ?? (at ? 0 : undefined);
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
          at
            ? sql`select adjust_stock_at(p_store => ${storeId}, p_location => ${at}, p_product => ${op.item.productId}, p_variant => ${op.item.variantId || null}, p_delta => ${op.delta}, p_reason => ${op.reason}, p_note => ${"Bulk update"}, p_actor => ${userId})`
            : sql`select adjust_stock(p_store => ${storeId}, p_product => ${op.item.productId}, p_variant => ${op.item.variantId || null}, p_delta => ${op.delta}, p_reason => ${op.reason}, p_note => ${"Bulk update"}, p_actor => ${userId})`,
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
