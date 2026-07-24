"use server";

// POS Phase 0 — enable/disable POS + manage store locations. All actions are
// gated on the `pos` dashboard section (getManagerIdentity), store-scoped, and
// re-check the store's EFFECTIVE plan server-side: POS is Pro-only, and the
// number of locations is capped by PLAN_LIMITS.posLocationsIncluded (extra
// locations are a paid add-on — see docs/pos-plan.md Phase 7).

import { and, count, eq, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { inventoryLevels, storeLocations, stores } from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { STORE_TAG } from "@/lib/store/resolve";
import { FEATURES_KEY } from "@/lib/settings/registry";
import { effectivePlan, limitsFor } from "@/lib/plans";
import { getStoreLocations, type StoreLocation } from "@/lib/pos/locations";

export interface ActionResult {
  success?: boolean;
  error?: string;
}

const LOCATION_TYPES = ["shop", "warehouse"] as const;
type LocationType = (typeof LOCATION_TYPES)[number];

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
  const type = LOCATION_TYPES.includes(input.type as LocationType)
    ? (input.type as LocationType)
    : "shop";
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

/** Guard shared by create/update/delete: POS must be Pro + enabled. Returns the
 *  store's effective plan/limits or an error. */
async function requirePosEnabled(storeId: string) {
  const store = await readStoreRow(storeId);
  const plan = effectivePlan(store ?? {});
  const limits = limitsFor(plan);
  if (!limits.posEnabled) {
    return { error: "Point of Sale is available on the Pro plan." as string };
  }
  const features = (store?.settings as Record<string, unknown>)?.[
    FEATURES_KEY
  ] as Record<string, unknown> | undefined;
  if (features?.["pos.enabled"] !== true) {
    return { error: "Enable POS first." as string };
  }
  return { limits };
}

export async function createLocation(
  input: LocationInput,
): Promise<{ location?: StoreLocation; error?: string }> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();

  const guard = await requirePosEnabled(storeId);
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
        isDefault: false,
        active: true,
        sortOrder: existing,
      }),
    );
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't add the location.") };
  }

  revalidatePath("/dashboard/pos/locations");
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

  const guard = await requirePosEnabled(storeId);
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

  revalidatePath("/dashboard/pos/locations");
  return { success: true };
}

export async function deleteLocation(id: string): Promise<ActionResult> {
  const admin = await getManagerIdentity("pos");
  if (!admin) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();
  if (typeof id !== "string" || !id) return { error: "Invalid location." };

  const guard = await requirePosEnabled(storeId);
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

  revalidatePath("/dashboard/pos/locations");
  return { success: true };
}
