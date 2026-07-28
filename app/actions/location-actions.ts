"use server";

// Locations — the places a store holds stock, and what each is allowed to DO
// (docs/locations-ia.md, docs/inventory-fulfilment-roadmap.md Phase B).
//
// Locations used to belong to POS. They do not: POS is one CAPABILITY of a
// location, and a warehouse is a location with POS switched off. Hence the
// `locations` permission section and the rename from pos-location-actions.
//
// enablePos/disablePos still live here because the POS toggle is what makes
// the section visible at all — but note the CRUD below deliberately does NOT
// require POS to be switched on. A Pro store must be able to add a warehouse
// for online fulfilment without ever opening a till.
//
// Every action is store-scoped and re-checks the EFFECTIVE plan server-side:
// multi-location is Pro-only, capped by PLAN_LIMITS.posLocationsIncluded.

import { and, count, eq, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  adminLocations,
  inventoryLevels,
  storeLocations,
  stores,
} from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { STORE_TAG } from "@/lib/store/resolve";
import { FEATURES_KEY } from "@/lib/settings/registry";
import { effectivePlan, limitsFor, type Plan } from "@/lib/plans";
import { getStoreLocations, type StoreLocation } from "@/lib/pos/locations";
import {
  CAPABILITY_REGISTRY,
  defaultCapabilitiesFor,
  isLocationType,
  normalizeCapabilities,
  type CapabilityMap,
  type LocationCapability,
  type LocationType,
} from "@/lib/locations/capabilities";

export interface ActionResult {
  success?: boolean;
  error?: string;
}

const MAX_NAME = 80;
const MAX_SHORT = 40;

function clean(v: string | undefined | null, max: number): string {
  return (v ?? "").toString().trim().slice(0, max);
}

async function readStoreRow(storeId: string) {
  const rows = await withService((db) =>
    db
      .select({
        settings: stores.settings,
        plan: stores.plan,
        plan_expires_at: stores.planExpiresAt,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  return rows[0];
}

// ---- Enable / disable POS -------------------------------------------------

async function setPosEnabled(
  storeId: string,
  enabled: boolean,
): Promise<ActionResult> {
  let store: Awaited<ReturnType<typeof readStoreRow>> | undefined;
  try {
    store = await readStoreRow(storeId);
  } catch (err) {
    console.error("setPosEnabled read:", err);
    return { error: "Couldn't load your store. Please try again." };
  }

  const plan = effectivePlan(store ?? {});
  if (enabled && !limitsFor(plan).posEnabled) {
    return { error: "Point of Sale is available on the Pro plan." };
  }

  // Ensure a default location exists before enabling (self-healing DB helper).
  if (enabled) {
    try {
      await withService((db) =>
        db.execute(sql`select pos_ensure_default_location(${storeId})`),
      );
    } catch (err) {
      console.error("pos_ensure_default_location:", err);
      return { error: "Couldn't set up POS. Please try again." };
    }
  }

  const settings = ((store?.settings as Record<string, unknown>) ??
    {}) as Record<string, unknown>;
  const features = {
    ...((settings[FEATURES_KEY] as Record<string, unknown>) ?? {}),
    "pos.enabled": enabled,
  };

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ settings: { ...settings, [FEATURES_KEY]: features } })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error("setPosEnabled:", err);
    return { error: "Couldn't save. Please try again." };
  }

  revalidateTag(STORE_TAG, "max");
  revalidatePath("/dashboard/pos");
  return { success: true };
}

export async function enablePos(): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  return setPosEnabled(await getActingStoreId(), true);
}

export async function disablePos(): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  return setPosEnabled(await getActingStoreId(), false);
}

// ---- Locations CRUD -------------------------------------------------------

export interface LocationInput {
  name: string;
  type?: string;
  gstin?: string | null;
  stateCode?: string | null;
  receiptPrefix?: string | null;
  address?: Record<string, unknown> | null;
}

function sanitizeInput(input: LocationInput) {
  // Fixed list, from the registry — free text would mean nothing to the
  // capability defaults.
  const type: LocationType = isLocationType(input.type) ? input.type : "shop";
  return {
    name: clean(input.name, MAX_NAME),
    type,
    gstin: clean(input.gstin, MAX_SHORT) || null,
    stateCode: clean(input.stateCode, 2).toUpperCase() || null,
    receiptPrefix: clean(input.receiptPrefix, 8).toUpperCase() || null,
    address:
      input.address && typeof input.address === "object" ? input.address : null,
  };
}

/**
 * Guard shared by create/update/delete. Multi-location is Pro — but
 * deliberately NOT gated on `pos.enabled`: a warehouse that only fulfils
 * online orders needs no till, and requiring one would mean switching on a
 * feature you do not want in order to reach a feature you do.
 */
async function requireLocationsAvailable(storeId: string) {
  const store = await readStoreRow(storeId);
  const plan = effectivePlan(store ?? {});
  const limits = limitsFor(plan);
  if (!limits.posEnabled) {
    return {
      error: "Multiple locations are available on the Pro plan." as string,
    };
  }
  return { limits, plan };
}

export async function createLocation(
  input: LocationInput,
): Promise<{ location?: StoreLocation; error?: string }> {
  const admin = await getManagerIdentity("locations");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();

  const guard = await requireLocationsAvailable(storeId);
  if ("error" in guard) return { error: guard.error };

  const data = sanitizeInput(input);
  if (!data.name) return { error: "Give the location a name." };

  // Location cap: included locations per plan (extra locations are a paid
  // add-on, not yet available — see docs/pos-plan.md Phase 7).
  let existing = 0;
  try {
    const rows = await withService((db) =>
      db
        .select({ n: count() })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId)),
    );
    existing = rows[0]?.n ?? 0;
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't add the location.") };
  }
  if (existing >= guard.limits.posLocationsIncluded) {
    return {
      error: `Your plan includes ${guard.limits.posLocationsIncluded} locations. Additional locations are ₹1,000/month — coming soon.`,
    };
  }

  try {
    await withService((db) =>
      db.insert(storeLocations).values({
        storeId,
        name: data.name,
        type: data.type,
        gstin: data.gstin,
        stateCode: data.stateCode,
        receiptPrefix: data.receiptPrefix,
        address: data.address,
        // Seeded from the type: a shop sells, a warehouse fulfils online.
        // Nothing customer-facing (pickup, returns) is ever on by default.
        capabilities: defaultCapabilitiesFor(data.type),
        isDefault: false,
        active: true,
        sortOrder: existing,
      }),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't add the location.") };
  }

  revalidatePath("/dashboard/locations");
  const locations = await getStoreLocations(storeId);
  return {
    location: locations.find((l) => l.name === data.name && !l.isDefault),
  };
}

export async function updateLocation(
  id: string,
  input: LocationInput,
): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid location." };

  const guard = await requireLocationsAvailable(storeId);
  if ("error" in guard) return { error: guard.error };

  const data = sanitizeInput(input);
  if (!data.name) return { error: "Give the location a name." };

  try {
    await withService((db) =>
      db
        .update(storeLocations)
        .set({
          name: data.name,
          type: data.type,
          gstin: data.gstin,
          stateCode: data.stateCode,
          receiptPrefix: data.receiptPrefix,
          address: data.address,
          updatedAt: new Date().toISOString(),
        })
        // Scope to the store so a location id from another tenant can't be edited.
        .where(
          and(eq(storeLocations.id, id), eq(storeLocations.storeId, storeId)),
        ),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save the location.") };
  }

  revalidatePath("/dashboard/locations");
  return { success: true };
}

export async function deleteLocation(id: string): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid location." };

  const guard = await requireLocationsAvailable(storeId);
  if ("error" in guard) return { error: guard.error };

  // Load the target + a count, store-scoped.
  let target: { is_default: boolean } | undefined;
  let total = 0;
  try {
    const [rows, countRows] = await withService(async (db) => {
      const rows = await db
        .select({ is_default: storeLocations.isDefault })
        .from(storeLocations)
        .where(
          and(eq(storeLocations.id, id), eq(storeLocations.storeId, storeId)),
        )
        .limit(1);
      const countRows = await db
        .select({ n: count() })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId));
      return [rows, countRows] as const;
    });
    target = rows[0];
    total = countRows[0]?.n ?? 0;
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't delete the location.") };
  }

  if (!target) return { error: "Location not found." };
  if (target.is_default)
    return { error: "You can't delete the main location." };
  if (total <= 1) return { error: "A store needs at least one location." };

  // Never silently vaporise stock: block deletion while the location holds any
  // non-zero inventory (the merchant must transfer/zero it first).
  try {
    const stockRows = await withService((db) =>
      db
        .select({ n: count() })
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.locationId, id),
            sql`${inventoryLevels.onHand} <> 0`,
          ),
        ),
    );
    if ((stockRows[0]?.n ?? 0) > 0) {
      return {
        error:
          "This location still has stock. Move or zero its inventory before deleting it.",
      };
    }
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't delete the location.") };
  }

  try {
    await withService((db) =>
      db
        .delete(storeLocations)
        .where(
          and(eq(storeLocations.id, id), eq(storeLocations.storeId, storeId)),
        ),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't delete the location.") };
  }

  revalidatePath("/dashboard/locations");
  return { success: true };
}

// ---- Capabilities ---------------------------------------------------------

export interface LocationWithCapabilities extends StoreLocation {
  capabilities: CapabilityMap;
}

export interface LocationsView {
  locations: LocationWithCapabilities[];
  plan: Plan;
  error?: string;
}

/** Locations plus their resolved capabilities, for the Locations section. */
export async function listLocations(): Promise<LocationsView> {
  const admin = await getManagerIdentity("locations");
  if (!admin) {
    return { locations: [], plan: "free", error: "You don't have permission." };
  }
  const storeId = await getActingStoreId();

  try {
    const [rows, store] = await Promise.all([
      withService((db) =>
        db
          .select({
            id: storeLocations.id,
            capabilities: storeLocations.capabilities,
          })
          .from(storeLocations)
          .where(eq(storeLocations.storeId, storeId)),
      ),
      readStoreRow(storeId),
    ]);
    const capsById = new Map(rows.map((r) => [r.id, r.capabilities]));
    const locations = await getStoreLocations(storeId);
    return {
      plan: effectivePlan(store ?? {}),
      locations: locations.map((l) => ({
        ...l,
        capabilities: normalizeCapabilities(capsById.get(l.id), l.type),
      })),
    };
  } catch (err) {
    return {
      locations: [],
      plan: "free",
      error: dbErrorMessage(err, "Couldn't load locations."),
    };
  }
}

/**
 * Save one location's capabilities.
 *
 * Two invariants the DB cannot express, enforced here rather than in the UI —
 * a disabled checkbox is not a permission (roadmap invariant 4):
 *
 *  1. A capability whose dependency is off is stored off too, so the saved
 *     state can never disagree with what locationCan() reports.
 *  2. The LAST location that fulfils online orders cannot be switched off.
 *     Doing so would leave the store advertising products it has no way to
 *     ship — checkout would fail on every order with no visible cause.
 */
export async function saveLocationCapabilities(
  id: string,
  input: Partial<CapabilityMap>,
): Promise<ActionResult> {
  const admin = await getManagerIdentity("locations");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid location." };

  const guard = await requireLocationsAvailable(storeId);
  if ("error" in guard) return { error: guard.error };

  let rows: Array<{ id: string; type: string; capabilities: unknown }>;
  try {
    rows = await withService((db) =>
      db
        .select({
          id: storeLocations.id,
          type: storeLocations.type,
          capabilities: storeLocations.capabilities,
        })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId)),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save the location.") };
  }

  const target = rows.find((r) => r.id === id);
  if (!target) return { error: "Location not found." };

  const current = normalizeCapabilities(
    target.capabilities,
    isLocationType(target.type) ? target.type : "shop",
  );
  // Only known keys, and only booleans — the client sends a partial map.
  const next: CapabilityMap = { ...current };
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === "boolean" && k in next) {
      next[k as LocationCapability] = v;
    }
  }

  // (1) A dependency that is off forces its dependants off.
  for (const cap of Object.keys(next) as LocationCapability[]) {
    for (const dep of CAPABILITY_REGISTRY[cap].requires ?? []) {
      if (!next[dep]) next[cap] = false;
    }
  }

  // (2) Never strand the store with nowhere to fulfil from.
  if (!next.online_fulfil) {
    const othersFulfil = rows.some((r) => {
      if (r.id === id) return false;
      const caps = normalizeCapabilities(
        r.capabilities,
        isLocationType(r.type) ? r.type : "shop",
      );
      return caps.online_fulfil;
    });
    if (!othersFulfil) {
      return {
        error:
          "This is the only location that fulfils online orders. Enable another one first.",
      };
    }
  }

  try {
    await withService((db) =>
      db
        .update(storeLocations)
        .set({ capabilities: next, updatedAt: new Date().toISOString() })
        .where(
          and(eq(storeLocations.id, id), eq(storeLocations.storeId, storeId)),
        ),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save the location.") };
  }

  revalidatePath("/dashboard/locations");
  revalidateTag(STORE_TAG, "max");
  return { success: true };
}

// ---- Admin location bindings (Phase B2) -----------------------------------

export interface AdminLocationBinding {
  adminId: string;
  locationIds: string[];
}

/**
 * Which locations each admin is restricted to.
 *
 * An admin absent from this map is UNRESTRICTED — absence is not restriction
 * (see lib/locations/scope.ts). The editor shows that as "All locations".
 */
export async function listAdminLocations(): Promise<{
  bindings: Record<string, string[]>;
  error?: string;
}> {
  const admin = await getManagerIdentity("admins");
  if (!admin) return { bindings: {}, error: "You don't have permission." };
  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select({
          admin_id: adminLocations.adminId,
          location_id: adminLocations.locationId,
        })
        .from(adminLocations)
        .where(eq(adminLocations.storeId, storeId)),
    );
    const bindings: Record<string, string[]> = {};
    for (const r of rows) {
      (bindings[r.admin_id] ??= []).push(r.location_id);
    }
    return { bindings };
  } catch (err) {
    return {
      bindings: {},
      error: dbErrorMessage(err, "Couldn't load location access."),
    };
  }
}

/**
 * Restrict an admin to `locationIds`, or pass an empty array to remove every
 * binding and return them to seeing the whole store.
 *
 * Gated on the `admins` section — deciding who sees which shop is a staff
 * permission, not a locations one.
 */
export async function setAdminLocations(
  adminId: string,
  locationIds: string[],
): Promise<ActionResult> {
  const admin = await getManagerIdentity("admins");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof adminId !== "string" || !adminId)
    return { error: "Invalid user." };

  const wanted = Array.isArray(locationIds)
    ? Array.from(new Set(locationIds.filter((v) => typeof v === "string" && v)))
    : [];

  try {
    // Only locations of THIS store — an id from another tenant must not be
    // storable, even though reading it later would filter to nothing anyway.
    const valid = await withService((db) =>
      db
        .select({ id: storeLocations.id })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId)),
    );
    const allowed = new Set(valid.map((v) => v.id));
    const rows = wanted.filter((id) => allowed.has(id));

    await withService(async (db) => {
      await db
        .delete(adminLocations)
        .where(
          and(
            eq(adminLocations.adminId, adminId),
            eq(adminLocations.storeId, storeId),
          ),
        );
      if (rows.length > 0) {
        await db
          .insert(adminLocations)
          .values(rows.map((id) => ({ adminId, locationId: id, storeId })));
      }
    });
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save location access.") };
  }

  revalidatePath("/dashboard/admins");
  return { success: true };
}
