"use server";

import { revalidatePath } from "next/cache";
import { platformAnalyticsSettings } from "@/drizzle/schema";
import { getPlatformViewer } from "@/app/actions/platform";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  ANALYTICS_FEATURE_IDS,
  resolveAnalyticsFeatureSettings,
  type AnalyticsFeatureId,
  type AnalyticsFeatureSettings,
} from "@/lib/analytics/features";

export type PlatformAnalyticsSettingsResult =
  | { success: true; settings: AnalyticsFeatureSettings }
  | { success?: false; error: string };

export async function savePlatformAnalyticsSettings(
  input: unknown,
): Promise<PlatformAnalyticsSettingsResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return {
      error: "Only a platform superadmin can change Analytics availability.",
    };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Analytics settings are invalid." };
  }

  const raw = input as Record<string, unknown>;
  for (const id of ANALYTICS_FEATURE_IDS) {
    if (typeof raw[id] !== "boolean") {
      return { error: `${id} must be enabled or disabled.` };
    }
  }
  const unknown = Object.keys(raw).filter(
    (key) => !(ANALYTICS_FEATURE_IDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) return { error: "Unknown Analytics setting." };

  const settings = resolveAnalyticsFeatureSettings(
    raw as Record<AnalyticsFeatureId, boolean>,
  );
  try {
    await withService((db) =>
      db
        .insert(platformAnalyticsSettings)
        .values({
          id: true,
          ...settings,
          updatedBy: viewer.email,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: platformAnalyticsSettings.id,
          set: {
            ...settings,
            updatedBy: viewer.email,
            updatedAt: new Date().toISOString(),
          },
        }),
    );
  } catch (error) {
    logError("savePlatformAnalyticsSettings failed", error, {
      operator: viewer.email,
    });
    return { error: "Couldn't save Analytics settings. Please try again." };
  }

  revalidatePath("/platform/dashboard/(console)/analytics", "page");
  revalidatePath("/dashboard/analytics");
  return { success: true, settings };
}
