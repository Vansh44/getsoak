// POS locations — server-side loaders + POS-state helpers, shared by the
// dashboard POS pages, the sidebar enable-flow, and the location actions.
// Store locations are admin-only data (RLS is_store_admin), so reads use the
// service scope with an explicit store_id filter, mirroring store-settings.ts.

import { asc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storeLocations } from "@/drizzle/schema";
import { effectivePlan, limitsFor, type Plan } from "@/lib/plans";
import { resolveStoreSettings } from "@/lib/settings/registry";

export interface StoreLocation {
  id: string;
  name: string;
  type: "shop" | "warehouse";
  gstin: string | null;
  stateCode: string | null;
  receiptPrefix: string | null;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  address: Record<string, unknown> | null;
}

// The minimal store shape the POS-state helpers need (snake_case plan_expires_at
// to match effectivePlan + the cached getCurrentStore() object).
export interface PosStoreShape {
  settings?: Record<string, unknown> | null | unknown;
  plan?: unknown;
  plan_expires_at?: string | Date | null;
}

/** Is POS switched on for this store? Resolves through the EFFECTIVE plan, so a
 *  lapsed Pro plan silently disables POS (the pos.enabled setting is minPlan:pro,
 *  so resolveStoreSettings forces it to false off-Pro). */
export function isPosEnabled(store: PosStoreShape): boolean {
  const plan = effectivePlan(store);
  return (
    resolveStoreSettings(
      (store.settings as Record<string, unknown>) ?? {},
      plan,
    )["pos.enabled"] === true
  );
}

export interface PosState {
  /** The store's effective plan. */
  plan: Plan;
  /** Pro (or better) — POS is available to enable. */
  posAvailable: boolean;
  /** POS is switched on. */
  posEnabled: boolean;
  /** Locations included at no extra cost on this plan. */
  locationsIncluded: number;
}

/** The three-state POS status used by the sidebar + overview page:
 *   !posAvailable            → "Included in Pro — upgrade"
 *   posAvailable && !enabled  → "Enable POS"
 *   posEnabled               → live. */
export function getPosState(store: PosStoreShape): PosState {
  const plan = effectivePlan(store);
  const limits = limitsFor(plan);
  return {
    plan,
    posAvailable: limits.posEnabled,
    posEnabled: isPosEnabled(store),
    locationsIncluded: limits.posLocationsIncluded,
  };
}

const LOCATION_COLUMNS = {
  id: storeLocations.id,
  name: storeLocations.name,
  type: storeLocations.type,
  gstin: storeLocations.gstin,
  state_code: storeLocations.stateCode,
  receipt_prefix: storeLocations.receiptPrefix,
  is_default: storeLocations.isDefault,
  active: storeLocations.active,
  sort_order: storeLocations.sortOrder,
  address: storeLocations.address,
};

function rowToLocation(r: Record<string, unknown>): StoreLocation {
  return {
    id: r.id as string,
    name: r.name as string,
    type: (r.type as "shop" | "warehouse") ?? "shop",
    gstin: (r.gstin as string) ?? null,
    stateCode: (r.state_code as string) ?? null,
    receiptPrefix: (r.receipt_prefix as string) ?? null,
    isDefault: !!r.is_default,
    active: !!r.active,
    sortOrder: (r.sort_order as number) ?? 0,
    address: (r.address as Record<string, unknown>) ?? null,
  };
}

/** All of a store's locations, default first then by sort order. */
export async function getStoreLocations(
  storeId: string,
): Promise<StoreLocation[]> {
  const rows = await withService((db) =>
    db
      .select(LOCATION_COLUMNS)
      .from(storeLocations)
      .where(eq(storeLocations.storeId, storeId))
      .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.createdAt)),
  );
  return rows
    .map((r) => rowToLocation(r as Record<string, unknown>))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}
