import "server-only";

// ---------------------------------------------------------------------------
// Low-stock / out-of-stock alerts.
//
// Stock only ever moves through the inventory RPCs (CODEBASE.md §13), so this
// module hangs off those same choke points rather than trying to observe the
// column. Two rules make it usable rather than annoying:
//
//  1. ALERT ON THE CROSSING, NOT THE STATE. A merchant with 3 units left does
//     not want a "low stock" mail on every one of the next 3 sales, and a sold
//     out SKU must not re-alert each time someone tries to buy it. So an alert
//     fires only on the transition (above the threshold → at or below it), and
//     restocking arms it again.
//  2. TRACKED SKUs ONLY. An untracked SKU's `stock` is meaningless, and a
//     backorderable one is deliberately allowed to go negative — neither is a
//     problem to report.
//
// The read runs deferred, after the response: the sale is what matters, and
// nobody's checkout should wait on an inventory alert.
// ---------------------------------------------------------------------------

import { after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { products, productVariants, stores } from "@/drizzle/schema";
import { effectiveLowStockThreshold } from "./status";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { effectivePlan } from "@/lib/plans";
import { logError } from "@/lib/observability/logger";
import { recordEvent } from "@/lib/notifications/record";

/**
 * Which alert (if any) a stock change earns. PURE — the whole decision lives
 * here so it can be tested without a database.
 *
 * @param previous stock before the change
 * @param next     stock after the change
 * @param threshold the SKU's effective low-stock threshold
 */
export function stockAlertFor(
  previous: number,
  next: number,
  threshold: number,
): "out" | "low" | null {
  // Crossed to empty. `previous > 0` is what stops a second sale on an
  // already-empty SKU (or a further negative move) from re-alerting.
  if (next <= 0) return previous > 0 ? "out" : null;
  // Crossed into the low band. A threshold of 0 disables the low alert
  // entirely — only "out" is meaningful then.
  if (threshold > 0 && next <= threshold && previous > threshold) return "low";
  return null;
}

/** One SKU that just moved, with the signed change that moved it. */
export interface StockChange {
  productId: string;
  variantId?: string | null;
  /** Signed: -2 for a sale of two units, +10 for a restock. */
  delta: number;
}

/**
 * Report stock changes, emitting inventory.low_stock / inventory.out_of_stock
 * for any SKU that just crossed a threshold.
 *
 * Deferred and fully swallowed: an alert must never affect the sale or the
 * adjustment that triggered it.
 */
export function reportStockChanges(
  storeId: string,
  changes: StockChange[],
): void {
  if (!storeId || changes.length === 0) return;
  try {
    after(async () => {
      try {
        await checkStockChanges(storeId, changes);
      } catch (err) {
        logError("notifications: stock alert failed", { err: String(err) });
      }
    });
  } catch {
    // No request scope to defer onto (a script, a test). The sale is what
    // matters — silently skip the alert rather than throw on the sell path.
  }
}

async function checkStockChanges(
  storeId: string,
  changes: StockChange[],
): Promise<void> {
  // Collapse repeats so two lines of the same SKU are one alert, not two.
  const byKey = new Map<string, StockChange>();
  for (const change of changes) {
    if (!change.productId || !Number.isFinite(change.delta) || !change.delta) {
      continue;
    }
    const key = `${change.productId}:${change.variantId ?? ""}`;
    const seen = byKey.get(key);
    if (seen) seen.delta += change.delta;
    else byKey.set(key, { ...change });
  }
  if (byKey.size === 0) return;

  // Resolved from the store ROW, not the host: this runs deferred and is also
  // reachable from cron-style paths where there is no request store to read.
  const storeRows = await withService((db) =>
    db
      .select({
        settings: stores.settings,
        plan: stores.plan,
        planExpiresAt: stores.planExpiresAt,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  const store = storeRows[0];
  if (!store) return;
  const storeDefault = Number(
    resolveStoreSettings(
      store.settings as Record<string, unknown> | null,
      effectivePlan({ plan: store.plan, plan_expires_at: store.planExpiresAt }),
    )["inventory.lowStockThreshold"],
  );

  const productIds = [...new Set([...byKey.values()].map((c) => c.productId))];
  const variantIds = [
    ...new Set(
      [...byKey.values()]
        .map((c) => c.variantId)
        .filter((id): id is string => !!id),
    ),
  ];

  // Sequential, not Promise.all: a scoped transaction holds ONE pooled
  // connection (lib/db/client.ts), so concurrent queries on it deadlock.
  const productRows = await withService((db) =>
    db
      .select({
        id: products.id,
        name: products.name,
        stock: products.stock,
        threshold: products.lowStockThreshold,
        tracked: products.trackInventory,
        backorder: products.allowBackorder,
      })
      .from(products)
      .where(
        and(eq(products.storeId, storeId), inArray(products.id, productIds)),
      ),
  );
  const variantRows = variantIds.length
    ? await withService((db) =>
        db
          .select({
            id: productVariants.id,
            productId: productVariants.productId,
            name: productVariants.name,
            stock: productVariants.stock,
            threshold: productVariants.lowStockThreshold,
            tracked: productVariants.trackInventory,
            backorder: productVariants.allowBackorder,
          })
          .from(productVariants)
          .where(inArray(productVariants.id, variantIds)),
      )
    : [];

  const productById = new Map(productRows.map((p) => [p.id, p]));
  const variantById = new Map(variantRows.map((v) => [v.id, v]));

  for (const change of byKey.values()) {
    const product = productById.get(change.productId);
    // Not this store's product (or deleted since) — nothing to say.
    if (!product) continue;

    const variant = change.variantId
      ? variantById.get(change.variantId)
      : undefined;
    if (change.variantId && (!variant || variant.productId !== product.id)) {
      continue;
    }

    const sku = variant ?? product;
    if (!sku.tracked || sku.backorder) continue;

    const next = Number(sku.stock ?? 0);
    const previous = next - change.delta;
    const threshold = effectiveLowStockThreshold(
      sku.threshold ?? null,
      storeDefault,
    );

    const alert = stockAlertFor(previous, next, threshold);
    if (!alert) continue;

    const label = variant ? `${product.name} — ${variant.name}` : product.name;
    await recordEvent({
      type: alert === "out" ? "inventory.out_of_stock" : "inventory.low_stock",
      storeId,
      actor: { type: "system" },
      subject: { type: "product", id: product.id, label },
      payload: {
        product: label,
        stock: next,
        threshold,
      },
    });
  }
}
