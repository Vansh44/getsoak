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
import { canRequirePrepaid } from "@/lib/fulfilment/payment-policy";
import { getStoreGateway } from "@/lib/payments/provider";
import { limitsFor } from "@/lib/plans";

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
  type: "boolean" | "number" | "select";
  value: boolean | number | string;
  /** select only: the allowed values, in render order. */
  options?: readonly { value: string; label: string; description?: string }[];
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
      options: def.options,
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
  values: Record<string, boolean | number | string>,
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
    const val = values[def.key];

    // ★ VALIDATED BY TYPE, AND ANYTHING THAT DOESN'T MATCH IS SKIPPED. This
    // used to write whatever arrived, on the reasoning that resolveStoreSettings
    // rejects a wrong-typed value on READ — true, but it leaves the stored blob
    // full of values that do nothing, which is exactly what makes a settings bug
    // impossible to diagnose from the database. Storing only what can be read
    // back keeps the row honest.
    if (def.type === "boolean") {
      if (typeof val !== "boolean") continue;
      features[def.key] = val;
      continue;
    }
    if (def.type === "number") {
      if (typeof val !== "number" || !Number.isFinite(val)) continue;
      features[def.key] = Math.max(
        def.min ?? -Infinity,
        Math.min(def.max ?? Infinity, val),
      );
      continue;
    }
    if (def.type === "select") {
      // ★ `prepaid` WITHOUT A GATEWAY MAKES PICKUP UNORDERABLE — every
      // collection would need an online payment the store cannot take. Refused
      // where the setting is SAVED, so the broken state never exists rather
      // than being discovered by a shopper at checkout.
      if (def.key === "fulfilment.pickupPayment" && val === "prepaid") {
        // Both halves of "can this store take money online", asked the way
        // checkout asks them: a connected AND enabled gateway, on a plan that
        // still includes online payments. The plan is already resolved above,
        // so this costs one query, not two.
        const gateway = await getStoreGateway(storeId).catch(() => null);
        const online = !!gateway?.enabled && limitsFor(plan).onlinePayments;
        if (!canRequirePrepaid(online)) {
          return {
            error:
              "Connect a payment gateway in Channels before requiring collection orders to be paid online.",
          };
        }
      }
      // The options list IS the allowlist. A client is a caller like any other
      // (invariant 5), so a value the UI never offered must be refused here and
      // not merely absent from the dropdown.
      if (
        typeof val !== "string" ||
        !def.options?.some((o) => o.value === val)
      ) {
        continue;
      }
      features[def.key] = val;
    }
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
