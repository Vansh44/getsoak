"use server";

import { eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { STORE_TAG } from "@/lib/store/resolve";
import { emitEvent } from "@/lib/notifications/record";
import {
  FEATURES_KEY,
  SETTINGS,
  planAllows,
  resolveStoreSettings,
} from "@/lib/settings/registry";
import { effectivePlan } from "@/lib/plans";

export interface ActionResult {
  success?: boolean;
  error?: string;
}

/** One catalog entry shaped for the dashboard editor. */
export interface EditorSetting {
  key: string;
  label: string;
  description: string;
  group: string;
  type: "boolean" | "number";
  value: boolean | number;
  /** True when the store's plan is below the setting's minimum — shown but
   *  not editable. */
  locked: boolean;
  minPlan?: string;
  dependsOn?: string;
  min?: number;
  max?: number;
}

// The acting store's row, in the snake_case shape effectivePlan expects.
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

// Feature settings for the acting store, shaped for the dashboard editors.
// Each setting is gated by ITS OWN dashboard section (def.section) — e.g. the
// Blogs group needs blogs.view — so feature settings live with their feature
// (blogs → /dashboard/blogs/settings). Pass `group` to fetch one group only.
export async function getStoreSettingsForEditor(group?: string): Promise<{
  plan: string;
  settings: EditorSetting[];
}> {
  const ctx = await getViewerContext();
  // dbError = the access lookup failed, not "you have no rights" (see access.ts).
  if (ctx?.dbError)
    throw new Error("Settings unavailable: database unreachable");
  if (!ctx?.profile) return { plan: "free", settings: [] };

  const visible = SETTINGS.filter(
    (def) =>
      !def.hidden &&
      (!group || def.group === group) &&
      can(ctx.permissions, def.section, "view", ctx.isSuperadmin),
  );
  if (visible.length === 0) return { plan: "free", settings: [] };

  let store: Awaited<ReturnType<typeof readStoreRow>> | undefined;
  try {
    store = await readStoreRow(ctx.storeId);
  } catch (err) {
    console.error("getStoreSettingsForEditor read:", err);
    store = undefined;
  }

  const plan = effectivePlan(store ?? {});
  const values = resolveStoreSettings(
    (store?.settings as Record<string, unknown>) ?? {},
    plan,
  );

  return {
    plan,
    settings: visible.map((def) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      group: def.group,
      type: def.type,
      value: values[def.key],
      locked: !planAllows(plan, def.minPlan),
      minPlan: def.minPlan,
      dependsOn: def.dependsOn,
      min: def.min,
      max: def.max,
    })),
  };
}

/**
 * Persist feature settings from the dashboard editors. Only keys in the
 * registry are accepted, non-boolean values are dropped, plan-locked settings
 * can't be changed, and each key requires `manage` on ITS owning dashboard
 * section (def.section). Merges into stores.settings.features (preserving
 * brand and everything else in settings), then busts the store-lookup cache so
 * the storefront and all setting reads update at once.
 */
export async function saveStoreSettings(
  values: Record<string, boolean | number>,
): Promise<ActionResult> {
  const ctx = await getViewerContext();
  if (ctx?.dbError) return { error: "Couldn't reach the database. Try again." };
  if (!ctx?.profile) return { error: "Not authenticated" };

  // Registry keys actually submitted vs. the subset this caller may change.
  const requested = SETTINGS.filter(
    (def) => typeof values[def.key] === def.type,
  );
  const permitted = requested.filter((def) =>
    can(ctx.permissions, def.section, "manage", ctx.isSuperadmin),
  );
  if (requested.length > 0 && permitted.length === 0) {
    return { error: "You don't have permission to change these settings." };
  }

  const storeId = ctx.storeId;

  let store: Awaited<ReturnType<typeof readStoreRow>> | undefined;
  try {
    store = await readStoreRow(storeId);
  } catch (err) {
    console.error(
      "saveStoreSettings read:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not load store settings. Please try again." };
  }

  const settings = ((store?.settings as Record<string, unknown>) ??
    {}) as Record<string, unknown>;
  const plan = effectivePlan(store ?? {});
  const features = {
    ...((settings[FEATURES_KEY] as Record<string, unknown>) ?? {}),
  };

  for (const def of permitted) {
    if (!planAllows(plan, def.minPlan)) continue; // locked on this plan
    let val = values[def.key];
    if (def.type === "number" && typeof val === "number") {
      val = Math.max(def.min ?? -Infinity, Math.min(def.max ?? Infinity, val));
    }
    features[def.key] = val;
  }

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ settings: { ...settings, [FEATURES_KEY]: features } })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error(
      "saveStoreSettings:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not save settings. Please try again." };
  }

  revalidateTag(STORE_TAG, "max");
  revalidatePath("/blogs");

  // In-app only by default: this is an audit breadcrumb ("who turned that
  // off?"), not something worth mailing a team about.
  emitEvent({
    type: "settings.changed",
    storeId,
    actor: { type: "admin", id: ctx.userId },
    payload: {
      settings: permitted.map((d) => d.label).join(", "),
      count: permitted.length,
    },
  });

  return { success: true };
}
