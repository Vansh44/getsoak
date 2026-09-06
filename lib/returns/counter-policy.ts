import "server-only";

import { eq } from "drizzle-orm";
import { storeLocations, stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  locationCan,
  normalizeCapabilities,
  type LocationType,
} from "@/lib/locations/capabilities";
import { effectivePlan } from "@/lib/plans";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { logError } from "@/lib/observability/logger";

export interface CounterReturnPolicy {
  enabled: boolean;
  allowInStore: boolean;
  allowExchanges: boolean;
  requireReason: boolean;
  windowDays: number;
  restockingFeePercent: number;
  locationAccepts: boolean;
}

/**
 * The merchant and location gates for a physical counter.
 *
 * Kept outside the server action so lookup, pricing, exchange setup and tests
 * all consume one answer. Any read failure fails closed: accepting goods and
 * paying money under an unknown policy is harder to recover than asking a
 * manager to retry.
 */
export async function getCounterReturnPolicy(
  storeId: string,
  locationId: string,
): Promise<CounterReturnPolicy> {
  const closed: CounterReturnPolicy = {
    enabled: false,
    allowInStore: false,
    allowExchanges: false,
    requireReason: true,
    windowDays: 0,
    restockingFeePercent: 0,
    locationAccepts: false,
  };

  try {
    const [storeRows, locationRows] = await Promise.all([
      withService((db) =>
        db
          .select({
            settings: stores.settings,
            plan: stores.plan,
            plan_expires_at: stores.planExpiresAt,
            comp_plan: stores.compPlan,
            comp_expires_at: stores.compExpiresAt,
          })
          .from(stores)
          .where(eq(stores.id, storeId))
          .limit(1),
      ),
      withService((db) =>
        db
          .select({
            capabilities: storeLocations.capabilities,
            type: storeLocations.type,
          })
          .from(storeLocations)
          .where(eq(storeLocations.id, locationId))
          .limit(1),
      ),
    ]);
    const store = storeRows[0];
    const location = locationRows[0];
    if (!store || !location) return closed;

    const plan = effectivePlan({
      plan: store.plan,
      plan_expires_at: store.plan_expires_at,
      comp_plan: store.comp_plan,
      comp_expires_at: store.comp_expires_at,
    });
    const settings = resolveStoreSettings(
      store.settings as Record<string, unknown> | null,
      plan,
    );
    const capabilities = normalizeCapabilities(
      location.capabilities,
      location.type as LocationType,
    );

    return {
      enabled: settings["returns.enabled"] === true,
      allowInStore: settings["returns.allowInStore"] === true,
      allowExchanges: settings["returns.allowExchanges"] === true,
      requireReason: settings["returns.requireReason"] === true,
      windowDays: Number(settings["returns.windowDays"]) || 0,
      restockingFeePercent:
        Number(settings["returns.restockingFeePercent"]) || 0,
      locationAccepts: locationCan(capabilities, "returns", { plan }),
    };
  } catch (error) {
    logError("pos.counter_return_policy", error, { storeId, locationId });
    return closed;
  }
}
