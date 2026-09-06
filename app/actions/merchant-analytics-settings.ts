"use server";

import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  analyticsFeatureAllowed,
  type AnalyticsFeatureSettings,
} from "@/lib/analytics/features";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import {
  MERCHANT_MARKETING_SETTINGS_KEY,
  isValidGa4MeasurementId,
  isValidMetaPixelId,
  normalizeGa4MeasurementId,
  normalizeMetaPixelId,
  resolveMerchantPixelSettings,
  type MerchantPixelSettings,
} from "@/lib/analytics/merchant-pixels";
import { effectivePlan, type Plan } from "@/lib/plans";
import { STORE_TAG } from "@/lib/store/resolve";
import { emitEvent } from "@/lib/notifications/record";

export interface MerchantAnalyticsSettingsEditor {
  plan: Plan;
  settings: MerchantPixelSettings;
  canManage: boolean;
  ga4Available: boolean;
  metaAvailable: boolean;
  ga4PlatformEnabled: boolean;
  metaPlatformEnabled: boolean;
}

export type MerchantAnalyticsSettingsResult =
  | { success: true; settings: MerchantPixelSettings }
  | { success?: false; error: string };

const STORE_COLUMNS = {
  settings: stores.settings,
  plan: stores.plan,
  plan_expires_at: stores.planExpiresAt,
  comp_plan: stores.compPlan,
  comp_expires_at: stores.compExpiresAt,
};

async function readStore(storeId: string) {
  const [store] = await withService((db) =>
    db
      .select(STORE_COLUMNS)
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  return store;
}

function availability(
  platform: AnalyticsFeatureSettings,
  plan: Plan,
): Pick<
  MerchantAnalyticsSettingsEditor,
  | "ga4Available"
  | "metaAvailable"
  | "ga4PlatformEnabled"
  | "metaPlatformEnabled"
> {
  return {
    ga4Available: analyticsFeatureAllowed(platform, "googleAnalytics4", plan),
    metaAvailable: analyticsFeatureAllowed(platform, "metaPixel", plan),
    ga4PlatformEnabled: platform.googleAnalytics4,
    metaPlatformEnabled: platform.metaPixel,
  };
}

export async function getMerchantAnalyticsSettingsForEditor(): Promise<MerchantAnalyticsSettingsEditor | null> {
  const ctx = await getViewerContext();
  if (ctx?.dbError)
    throw new Error("Analytics settings unavailable: database unreachable");
  if (
    !ctx?.profile ||
    !can(ctx.permissions, "settings", "view", ctx.isSuperadmin)
  ) {
    return null;
  }

  const [store, platform] = await Promise.all([
    readStore(ctx.storeId),
    getPlatformAnalyticsFeatures(),
  ]);
  if (!store) return null;
  const plan = effectivePlan(store);

  return {
    plan,
    settings: resolveMerchantPixelSettings(
      store.settings as Record<string, unknown>,
    ),
    canManage: can(ctx.permissions, "settings", "manage", ctx.isSuperadmin),
    ...availability(platform, plan),
  };
}

export async function saveMerchantAnalyticsSettings(
  input: unknown,
): Promise<MerchantAnalyticsSettingsResult> {
  const ctx = await getViewerContext();
  if (ctx?.dbError) return { error: "Couldn't reach the database. Try again." };
  if (!ctx?.profile) return { error: "Not authenticated." };
  if (!can(ctx.permissions, "settings", "manage", ctx.isSuperadmin)) {
    return { error: "You don't have permission to change Analytics settings." };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Analytics settings are invalid." };
  }

  const raw = input as Record<string, unknown>;
  if (
    typeof raw.ga4MeasurementId !== "string" ||
    typeof raw.ga4Enabled !== "boolean" ||
    typeof raw.metaPixelId !== "string" ||
    typeof raw.metaPixelEnabled !== "boolean"
  ) {
    return { error: "Analytics settings are invalid." };
  }
  const requested: MerchantPixelSettings = {
    ga4MeasurementId: normalizeGa4MeasurementId(raw.ga4MeasurementId),
    ga4Enabled: raw.ga4Enabled,
    metaPixelId: normalizeMetaPixelId(raw.metaPixelId),
    metaPixelEnabled: raw.metaPixelEnabled,
  };
  if (
    requested.ga4MeasurementId &&
    !isValidGa4MeasurementId(requested.ga4MeasurementId)
  ) {
    return {
      error: "Enter a valid GA4 Measurement ID beginning with G-.",
    };
  }
  if (requested.metaPixelId && !isValidMetaPixelId(requested.metaPixelId)) {
    return { error: "Enter a valid numeric Meta Pixel ID." };
  }
  if (requested.ga4Enabled && !requested.ga4MeasurementId) {
    return { error: "Enter a GA4 Measurement ID before enabling GA4." };
  }
  if (requested.metaPixelEnabled && !requested.metaPixelId) {
    return { error: "Enter a Meta Pixel ID before enabling Meta Pixel." };
  }

  const [store, platform] = await Promise.all([
    readStore(ctx.storeId),
    getPlatformAnalyticsFeatures(),
  ]);
  if (!store) return { error: "Store not found." };
  const plan = effectivePlan(store);
  const allowed = availability(platform, plan);
  const existingSettings = (store.settings ?? {}) as Record<string, unknown>;
  const existingPixels = resolveMerchantPixelSettings(existingSettings);
  const next: MerchantPixelSettings = {
    ga4MeasurementId: allowed.ga4Available
      ? requested.ga4MeasurementId
      : existingPixels.ga4MeasurementId,
    ga4Enabled: allowed.ga4Available
      ? requested.ga4Enabled
      : existingPixels.ga4Enabled,
    metaPixelId: allowed.metaAvailable
      ? requested.metaPixelId
      : existingPixels.metaPixelId,
    metaPixelEnabled: allowed.metaAvailable
      ? requested.metaPixelEnabled
      : existingPixels.metaPixelEnabled,
  };
  if (!allowed.ga4Available && !allowed.metaAvailable) {
    return {
      error:
        plan !== "pro"
          ? "GA4 and Meta Pixel are available on the Pro plan."
          : "StoreMink has not enabled merchant tracking connections yet.",
    };
  }

  const currentMarketing =
    existingSettings[MERCHANT_MARKETING_SETTINGS_KEY] &&
    typeof existingSettings[MERCHANT_MARKETING_SETTINGS_KEY] === "object" &&
    !Array.isArray(existingSettings[MERCHANT_MARKETING_SETTINGS_KEY])
      ? (existingSettings[MERCHANT_MARKETING_SETTINGS_KEY] as Record<
          string,
          unknown
        >)
      : {};
  const marketing = {
    ...currentMarketing,
    ga4MeasurementId: next.ga4MeasurementId || null,
    ga4Enabled: next.ga4Enabled,
    metaPixelId: next.metaPixelId || null,
    metaPixelEnabled: next.metaPixelEnabled,
  };

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({
          settings: {
            ...existingSettings,
            [MERCHANT_MARKETING_SETTINGS_KEY]: marketing,
          },
        })
        .where(eq(stores.id, ctx.storeId)),
    );
  } catch {
    return { error: "Couldn't save Analytics settings. Please try again." };
  }

  updateTag(STORE_TAG);
  revalidatePath("/dashboard/settings/analytics");
  emitEvent({
    type: "settings.changed",
    storeId: ctx.storeId,
    actor: { type: "admin", id: ctx.userId },
    payload: {
      settings: "GA4 and Meta Pixel",
      count: Number(allowed.ga4Available) + Number(allowed.metaAvailable),
    },
  });

  return { success: true, settings: next };
}
