import "server-only";

// Resolve where an online order ships from (roadmap Phase D).
//
// The pure ranking lives in strategies.ts; this loads the candidates and the
// store's rules, then hands both to it.
//
// ⚠ FALLING BACK IS DELIBERATE. If anything here cannot produce an answer —
// no rules row, no eligible location, a failed query — the caller keeps using
// the store's DEFAULT location via the reserve_stock wrapper, which is exactly
// what every store did before this phase. Routing must never be the reason a
// sale is refused.

import { and, eq, inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  inventoryLevels,
  storeFulfilmentRules,
  storeLocations,
} from "@/drizzle/schema";
import {
  normalizeCapabilities,
  isLocationType,
} from "@/lib/locations/capabilities";
import {
  pickFulfilmentLocation,
  type FulfilmentCandidate,
  type FulfilmentLine,
} from "./strategies";

export const lineKey = (productId: string, variantId: string | null) =>
  `${productId}:${variantId ?? ""}`;

export interface OrderLineForRouting {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** False for untracked / backorderable SKUs — they never block a location. */
  needsStock: boolean;
}

/**
 * Which location should fulfil this order, or null to fall back to the
 * store's default.
 */
export async function resolveFulfilmentLocation(
  storeId: string,
  lines: OrderLineForRouting[],
): Promise<string | null> {
  if (lines.length === 0) return null;

  try {
    const productIds = Array.from(new Set(lines.map((l) => l.productId)));

    const [locRows, ruleRows, levelRows] = await withService(async (db) => {
      const locRows = await db
        .select({
          id: storeLocations.id,
          name: storeLocations.name,
          type: storeLocations.type,
          active: storeLocations.active,
          capabilities: storeLocations.capabilities,
        })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId));

      const ruleRows = await db
        .select({
          strategy: storeFulfilmentRules.strategy,
          priority: storeFulfilmentRules.priority,
          skip_inactive: storeFulfilmentRules.skipInactive,
        })
        .from(storeFulfilmentRules)
        .where(eq(storeFulfilmentRules.storeId, storeId))
        .limit(1);

      const levelRows = await db
        .select({
          location_id: inventoryLevels.locationId,
          product_id: inventoryLevels.productId,
          variant_id: inventoryLevels.variantId,
          on_hand: inventoryLevels.onHand,
        })
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.storeId, storeId),
            inArray(inventoryLevels.productId, productIds),
          ),
        );

      return [locRows, ruleRows, levelRows] as const;
    });

    // Only one location can fulfil anyway — nothing to decide, and the wrapper
    // already targets it.
    if (locRows.length <= 1) return null;

    const stockByLocation = new Map<string, Map<string, number>>();
    for (const l of levelRows) {
      const m = stockByLocation.get(l.location_id) ?? new Map<string, number>();
      m.set(lineKey(l.product_id, l.variant_id), Number(l.on_hand) || 0);
      stockByLocation.set(l.location_id, m);
    }

    const candidates: FulfilmentCandidate[] = locRows.map((l) => {
      const caps = normalizeCapabilities(
        l.capabilities,
        isLocationType(l.type) ? l.type : "shop",
      );
      return {
        id: l.id,
        name: l.name,
        active: l.active,
        fulfilsOnline: caps.online_fulfil,
        stock: stockByLocation.get(l.id) ?? new Map(),
      };
    });

    const rule = ruleRows[0];
    const priority = Array.isArray(rule?.priority)
      ? (rule.priority as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];

    const routingLines: FulfilmentLine[] = lines.map((l) => ({
      key: lineKey(l.productId, l.variantId),
      quantity: l.quantity,
      needsStock: l.needsStock,
    }));

    return pickFulfilmentLocation(
      {
        candidates,
        lines: routingLines,
        priority,
        skipInactive: rule?.skip_inactive ?? true,
      },
      rule?.strategy,
    );
  } catch {
    // Routing is an optimisation over "use the default location". A failure
    // here must never refuse a sale.
    return null;
  }
}
