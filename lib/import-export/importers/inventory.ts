import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withService, withUser } from "@/lib/db/client";
import {
  inventoryLevels,
  productVariants,
  products,
  storeLocations,
} from "@/drizzle/schema";
import { dbErrorMessage } from "@/lib/db/errors";
import { getViewerLocations } from "@/lib/locations/scope";
import { reportStockChanges } from "@/lib/inventory/alerts";
import type { ParsedRecord } from "../types";
import { failure, issue, type ImportContext, type RowResult } from "./types";

interface SkuTarget {
  productId: string;
  variantId: string | null;
  label: string;
}

/**
 * Import stock counts, matched on SKU.
 *
 * ★ THE COUNT IS APPLIED AS A DELTA THROUGH `adjust_stock_at`, NEVER WRITTEN.
 * Three separate reasons, any one of which is sufficient:
 *
 *  1. `products.stock` is a trigger-maintained AGGREGATE of `inventory_levels`
 *     (pos_01_inventory_levels.sql). Writing it directly is reverted by the
 *     next sale and breaks the aggregate invariant until then.
 *  2. The RPC is atomic and row-locked. A stocktake uploaded while the shop is
 *     selling would otherwise lose whatever was rung during the upload.
 *  3. It writes the `stock_movements` ledger row. A count that leaves no trace
 *     is indistinguishable from stock going missing, which is precisely the
 *     thing a stocktake exists to detect.
 *
 * The delta is computed against THAT LOCATION's shelf, not the cross-location
 * total — the same trap `setStock` documents. Against the aggregate, "set
 * Delhi to 9" would write a wildly wrong correction.
 */
export async function importInventory(
  ctx: ImportContext,
  records: readonly ParsedRecord[],
): Promise<RowResult[]> {
  const results: RowResult[] = [];
  if (records.length === 0) return results;

  // --- locations -----------------------------------------------------------
  // A location-bound admin (admin_locations) may only count their own shops.
  // The file names locations by TEXT, so without this check a manager could
  // type another branch's name and adjust its stock.
  const scope = await getViewerLocations();

  let locations: { id: string; name: string; isDefault: boolean }[];
  try {
    locations = await withService((db) =>
      db
        .select({
          id: storeLocations.id,
          name: storeLocations.name,
          isDefault: storeLocations.isDefault,
        })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.storeId, ctx.storeId),
            eq(storeLocations.active, true),
          ),
        ),
    );
  } catch (error) {
    const message = dbErrorMessage(error, "Couldn't read your locations.");
    return records.map((r) => failure([r.line], message, "lookup_failed"));
  }

  const allowed = locations.filter(
    (l) => scope === null || scope.includes(l.id),
  );
  const byName = new Map(allowed.map((l) => [l.name.trim().toLowerCase(), l]));
  const defaultLocation =
    allowed.find((l) => l.id === ctx.options.locationId) ??
    allowed.find((l) => l.isDefault) ??
    allowed[0];

  if (!defaultLocation) {
    return records.map((r) =>
      failure(
        [r.line],
        "You don't have access to any location, so there's nowhere to apply these counts.",
        "no_location",
      ),
    );
  }

  // --- SKUs ----------------------------------------------------------------
  const skus = [
    ...new Set(
      records
        .map((r) => String(r.values.sku ?? "").trim())
        .filter(Boolean)
        .map((s) => s.toUpperCase()),
    ),
  ];

  const targets = new Map<string, SkuTarget>();
  try {
    const [productRows, variantRows] = await Promise.all([
      withUser(ctx.admin, (db) =>
        db
          .select({ id: products.id, sku: products.sku, name: products.name })
          .from(products)
          .where(
            and(
              eq(products.storeId, ctx.storeId),
              inArray(sql`upper(${products.sku})`, skus),
            ),
          ),
      ),
      withUser(ctx.admin, (db) =>
        db
          .select({
            id: productVariants.id,
            productId: productVariants.productId,
            sku: productVariants.sku,
            name: productVariants.name,
            productName: products.name,
          })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(
            and(
              eq(productVariants.storeId, ctx.storeId),
              inArray(sql`upper(${productVariants.sku})`, skus),
            ),
          ),
      ),
    ]);

    for (const p of productRows) {
      targets.set(p.sku.toUpperCase(), {
        productId: p.id,
        variantId: null,
        label: p.name,
      });
    }
    for (const v of variantRows) {
      targets.set(v.sku.toUpperCase(), {
        productId: v.productId,
        variantId: v.id,
        label: `${v.productName} — ${v.name}`,
      });
    }
  } catch (error) {
    const message = dbErrorMessage(error, "Couldn't look up those SKUs.");
    return records.map((r) => failure([r.line], message, "lookup_failed"));
  }

  // --- current shelf levels ------------------------------------------------
  const changes: {
    productId: string;
    variantId: string | null;
    delta: number;
  }[] = [];

  for (const record of records) {
    const rawSku = String(record.values.sku ?? "").trim();
    const issues = record.issues.filter((i) => i.severity === "warning");

    const target = targets.get(rawSku.toUpperCase());
    if (!target) {
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [
          ...issues,
          issue(
            record.line,
            "SKU",
            "unknown_sku",
            `No product or variant in this store has the SKU "${rawSku}". SKUs are issued by StoreMink — export your inventory first to get the right ones.`,
            "error",
            rawSku,
          ),
        ],
      });
      continue;
    }

    // An inventory row can only ever ADJUST something that exists, so the
    // create/update toggles collapse to one question here.
    if (!ctx.options.update) {
      results.push({ lines: [record.line], outcome: "skipped", issues });
      continue;
    }

    const onHand = record.values.onHand;
    if (typeof onHand !== "number") {
      results.push({
        lines: [record.line],
        outcome: "skipped",
        issues: [
          ...issues,
          issue(
            record.line,
            "On Hand",
            "no_count",
            "No On Hand value on this row, so nothing was changed.",
            "warning",
          ),
        ],
      });
      continue;
    }

    let location = defaultLocation;
    const named = String(record.values.location ?? "").trim();
    if (named) {
      const match = byName.get(named.toLowerCase());
      if (!match) {
        // Distinguish "no such shop" from "not yours" only in as much as both
        // refuse — naming which of your colleagues' shops exist is not
        // something a permission boundary should volunteer.
        results.push({
          lines: [record.line],
          outcome: "failed",
          issues: [
            ...issues,
            issue(
              record.line,
              "Location",
              "unknown_location",
              `"${named}" isn't a location you can adjust stock at.`,
              "error",
              named,
            ),
          ],
        });
        continue;
      }
      location = match;
    }

    try {
      const current = await withService(async (db) => {
        const rows = await db
          .select({ onHand: inventoryLevels.onHand })
          .from(inventoryLevels)
          .where(
            and(
              eq(inventoryLevels.storeId, ctx.storeId),
              eq(inventoryLevels.locationId, location.id),
              eq(inventoryLevels.productId, target.productId),
              target.variantId
                ? eq(inventoryLevels.variantId, target.variantId)
                : isNull(inventoryLevels.variantId),
            ),
          )
          .limit(1);
        // A shop that has never carried this SKU holds zero of it — which is
        // the normal case when stocking a new branch, not an error.
        return rows[0]?.onHand ?? 0;
      });

      const delta = onHand - current;
      if (delta === 0) {
        // Confirming a figure that already matches must not litter the ledger
        // — a stocktake is mostly rows that agree.
        results.push({
          lines: [record.line],
          outcome: "skipped",
          issues: [
            ...issues,
            issue(
              record.line,
              "On Hand",
              "already_correct",
              `${target.label} at ${location.name} is already ${onHand}.`,
              "warning",
            ),
          ],
        });
        continue;
      }

      await withService((db) =>
        db.execute(
          sql`select adjust_stock_at(p_store => ${ctx.storeId}, p_location => ${location.id}, p_product => ${target.productId}, p_variant => ${target.variantId}, p_delta => ${delta}, p_reason => ${"import"}, p_note => ${`CSV import — counted ${onHand} at ${location.name}`}, p_actor => ${ctx.admin.uid}) as new_stock`,
        ),
      );

      changes.push({
        productId: target.productId,
        variantId: target.variantId,
        delta,
      });

      results.push({ lines: [record.line], outcome: "updated", issues });
    } catch (error) {
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [
          ...issues,
          issue(
            record.line,
            null,
            "write_failed",
            dbErrorMessage(error, "Couldn't adjust this stock level."),
          ),
        ],
      });
    }
  }

  // A manual correction down to zero must still fire the low/out-of-stock
  // crossing (CODEBASE §22) — otherwise the one change most worth alerting on
  // is the one that alerts nobody. Deferred and best-effort inside the helper.
  if (changes.length > 0) reportStockChanges(ctx.storeId, changes);

  return results;
}
