"use server";

// POS Phase 4 — inventory from the shop floor, scoped to the operator's own
// location (docs/pos-plan.md Phase 4).
//
// This is the counterpart to /dashboard/inventory, which writes to the store's
// DEFAULT location via the compatibility wrappers. Here a manager standing in
// a specific shop counts, corrects and receives stock for THAT shop, and can
// send stock to another one.
//
// Every write needs `adjust_inventory` (manager/owner) — a cashier sells stock
// but does not get to declare how much of it exists. The location always comes
// from the operator's session; the only location a caller may name is the
// DESTINATION of a transfer, and that is verified to belong to the store both
// here and again inside the RPC.

import { and, eq, ilike, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  inventoryLevels,
  productVariants,
  products,
  storeLocations,
} from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { getStoreSettings } from "@/lib/settings/resolve";
import { TAGS } from "@/lib/storefront/tags";

/** A single correction larger than this is a typo, not a stocktake. */
const MAX_DELTA = 1_000_000;

export interface PosInventoryItem {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  image: string | null;
  /** On hand at THIS location. Null when the SKU isn't tracked. */
  onHand: number | null;
  trackInventory: boolean;
  lowStockThreshold: number | null;
  /** Below the per-SKU threshold, or the store default. */
  low: boolean;
}

export interface PosTransferTarget {
  id: string;
  name: string;
}

function opError(msg: string) {
  return { items: [] as PosInventoryItem[], error: msg };
}

/**
 * Stock at the operator's location. Untracked SKUs are excluded — there is
 * nothing to count, and listing them makes a stocktake screen noisy.
 */
export async function getPosInventory(opts?: {
  query?: string;
  lowOnly?: boolean;
  limit?: number;
}): Promise<{ items: PosInventoryItem[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return opError("Not signed in.");
  if (!posCan(op.role, "adjust_inventory")) return opError("Not allowed.");

  const q = (opts?.query ?? "").trim().slice(0, 100);
  const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 50) || 50, 1), 200);

  let storeThreshold = 0;
  try {
    storeThreshold =
      Number((await getStoreSettings())["inventory.lowStockThreshold"]) || 0;
  } catch {
    storeThreshold = 0;
  }

  try {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = await withService((db) =>
      db
        .select({
          product_id: products.id,
          variant_id: productVariants.id,
          name: products.name,
          variant_name: productVariants.name,
          p_sku: products.sku,
          v_sku: productVariants.sku,
          p_barcode: products.barcode,
          v_barcode: productVariants.barcode,
          p_image: products.imageUrl,
          v_image: productVariants.imageUrl,
          p_track: products.trackInventory,
          v_track: productVariants.trackInventory,
          p_low: products.lowStockThreshold,
          v_low: productVariants.lowStockThreshold,
          on_hand: inventoryLevels.onHand,
        })
        .from(products)
        .leftJoin(productVariants, eq(productVariants.productId, products.id))
        .leftJoin(
          inventoryLevels,
          and(
            eq(inventoryLevels.productId, products.id),
            eq(inventoryLevels.locationId, op.locationId),
            sql`${inventoryLevels.variantId} is not distinct from ${productVariants.id}`,
          ),
        )
        .where(
          and(
            eq(products.storeId, op.storeId),
            eq(products.status, "published"),
            q
              ? or(
                  eq(products.barcode, q),
                  eq(productVariants.barcode, q),
                  eq(products.sku, q),
                  eq(productVariants.sku, q),
                  ilike(products.name, pattern),
                )
              : undefined,
          ),
        )
        .limit(limit),
    );

    const items: PosInventoryItem[] = [];
    for (const r of rows) {
      const isVariant = !!r.variant_id;
      const tracked = isVariant ? !!r.v_track : !!r.p_track;
      // Nothing to count on an untracked SKU.
      if (!tracked) continue;
      const onHand = r.on_hand ?? 0;
      const threshold = (isVariant ? r.v_low : r.p_low) ?? storeThreshold ?? 0;
      items.push({
        productId: r.product_id,
        variantId: r.variant_id,
        name: r.name,
        variantName: r.variant_name,
        sku: (isVariant ? r.v_sku : r.p_sku) ?? null,
        barcode: (isVariant ? r.v_barcode : r.p_barcode) ?? null,
        image: (isVariant ? r.v_image : r.p_image) ?? r.p_image ?? null,
        onHand,
        trackInventory: true,
        lowStockThreshold: threshold || null,
        low: threshold > 0 && onHand <= threshold,
      });
    }

    return {
      items: opts?.lowOnly ? items.filter((i) => i.low) : items,
    };
  } catch (err) {
    return opError(dbErrorMessage(err, "Couldn't load stock."));
  }
}

async function requireInventoryOperator() {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." as const, op: null };
  if (!posCan(op.role, "adjust_inventory")) {
    return {
      error: "Only a manager or the owner can change stock." as const,
      op: null,
    };
  }
  return { error: null, op };
}

/** Correct stock at this location by a delta — a breakage, a found box. */
export async function adjustPosStock(
  productId: string,
  variantId: string | null,
  delta: number,
  reason = "adjustment",
  note?: string,
): Promise<{ success?: boolean; newStock?: number; error?: string }> {
  const { error, op } = await requireInventoryOperator();
  if (!op) return { error: error! };

  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_DELTA) {
    return { error: "Enter a valid quantity." };
  }

  try {
    // adjust_stock_at is atomic and writes the ledger row itself; the location
    // is the operator's, never the client's.
    const res = await withService((db) =>
      db.execute(
        sql`select adjust_stock_at(p_store => ${op.storeId}, p_location => ${op.locationId}, p_product => ${productId}, p_variant => ${variantId || null}, p_delta => ${delta}, p_reason => ${reason}, p_note => ${note?.trim().slice(0, 200) || null}, p_actor => ${op.staffId ?? op.name}) as new_stock`,
      ),
    );
    const newStock = Number(
      (res.rows[0] as { new_stock?: number | string })?.new_stock,
    );

    revalidateTag(TAGS.products, "max");
    revalidatePath("/pos/inventory");

    emitEvent({
      type: "inventory.adjusted",
      storeId: op.storeId,
      actor: { type: "admin", id: op.staffId ?? op.name },
      subject: { type: "product", id: variantId || productId },
      payload: {
        delta,
        stock: newStock,
        reason,
        location: op.locationId,
        ...(note ? { note } : {}),
      },
    });
    // Low/out-of-stock alerts fire on the CROSSING, not the state (§22).
    reportStockChanges(op.storeId, [{ productId, variantId, delta }]);

    return { success: true, newStock };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't adjust stock.") };
  }
}

/**
 * A physical count: set the on-hand to what was actually counted.
 *
 * Expressed as a DELTA against the live figure rather than an absolute write,
 * so it goes through the same atomic RPC and leaves the same ledger trail —
 * and so a sale rung between the count and the save is not silently erased.
 */
export async function countPosStock(
  productId: string,
  variantId: string | null,
  counted: number,
  note?: string,
): Promise<{ success?: boolean; newStock?: number; error?: string }> {
  const { error, op } = await requireInventoryOperator();
  if (!op) return { error: error! };

  if (!Number.isInteger(counted) || counted < 0 || counted > MAX_DELTA) {
    return { error: "Enter a valid count." };
  }

  let current = 0;
  try {
    const rows = await withService((db) =>
      db
        .select({ on_hand: inventoryLevels.onHand })
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.storeId, op.storeId),
            eq(inventoryLevels.locationId, op.locationId),
            eq(inventoryLevels.productId, productId),
            variantId
              ? eq(inventoryLevels.variantId, variantId)
              : sql`${inventoryLevels.variantId} is null`,
          ),
        )
        .limit(1),
    );
    current = Number(rows[0]?.on_hand) || 0;
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't read current stock.") };
  }

  const delta = counted - current;
  if (delta === 0) return { success: true, newStock: counted };

  return adjustPosStock(
    productId,
    variantId,
    delta,
    "count",
    note ?? `Counted ${counted}`,
  );
}

/** The store's OTHER locations — where stock can be sent from here. */
export async function getTransferTargets(): Promise<{
  targets: PosTransferTarget[];
  error?: string;
}> {
  const { error, op } = await requireInventoryOperator();
  if (!op) return { targets: [], error: error! };
  try {
    const rows = await withService((db) =>
      db
        .select({ id: storeLocations.id, name: storeLocations.name })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.storeId, op.storeId),
            eq(storeLocations.active, true),
          ),
        )
        .orderBy(storeLocations.sortOrder, storeLocations.name),
    );
    return { targets: rows.filter((r) => r.id !== op.locationId) };
  } catch (err) {
    return { targets: [], error: dbErrorMessage(err, "Couldn't load shops.") };
  }
}

/**
 * Send stock from this location to another of the store's.
 *
 * The whole operation is one RPC because it touches TWO locations: the app has
 * no cross-statement transaction over the pool, so doing it as two adjustments
 * could decrement the source and then fail to credit the destination, and the
 * units would simply cease to exist on the store's books.
 */
export async function transferPosStock(
  productId: string,
  variantId: string | null,
  quantity: number,
  toLocationId: string,
  note?: string,
): Promise<{ success?: boolean; error?: string }> {
  const { error, op } = await requireInventoryOperator();
  if (!op) return { error: error! };

  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_DELTA) {
    return { error: "Enter a valid quantity." };
  }
  if (typeof toLocationId !== "string" || !toLocationId) {
    return { error: "Choose where to send it." };
  }
  if (toLocationId === op.locationId) {
    return { error: "That's this shop." };
  }

  try {
    const res = await withService((db) =>
      db.execute(
        sql`select transfer_stock(p_store => ${op.storeId}, p_from => ${op.locationId}, p_to => ${toLocationId}, p_product => ${productId}, p_variant => ${variantId || null}, p_qty => ${quantity}, p_note => ${note?.trim().slice(0, 200) || null}, p_actor => ${op.staffId ?? op.name}) as ok`,
      ),
    );
    const ok = (res.rows[0] as { ok?: boolean } | undefined)?.ok === true;
    if (!ok) {
      // The RPC refuses on insufficient stock, a same/foreign location, or a
      // bad quantity — all of which read the same way to a manager holding
      // the shelf.
      return { error: "Not enough stock here to send that." };
    }

    revalidateTag(TAGS.products, "max");
    revalidatePath("/pos/inventory");

    emitEvent({
      type: "inventory.adjusted",
      storeId: op.storeId,
      actor: { type: "admin", id: op.staffId ?? op.name },
      subject: { type: "product", id: variantId || productId },
      payload: {
        delta: -quantity,
        reason: "transfer_out",
        from: op.locationId,
        to: toLocationId,
        ...(note ? { note } : {}),
      },
    });
    // Only THIS location lost stock; the destination gained it, so the
    // crossing that matters for a low-stock alert is the source's.
    reportStockChanges(op.storeId, [
      { productId, variantId, delta: -quantity },
    ]);

    return { success: true };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't send the stock.") };
  }
}
