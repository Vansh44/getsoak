import "server-only";

import { eq } from "drizzle-orm";
import { platformAnalyticsSettings } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  DEFAULT_ANALYTICS_FEATURE_SETTINGS,
  resolveAnalyticsFeatureSettings,
  type AnalyticsFeatureSettings,
} from "./features";

export async function getPlatformAnalyticsFeatures(): Promise<AnalyticsFeatureSettings> {
  try {
    const [row] = await withService((db) =>
      db
        .select({
          coreDashboard: platformAnalyticsSettings.coreDashboard,
          dashboardCustomization:
            platformAnalyticsSettings.dashboardCustomization,
          drilldownReports: platformAnalyticsSettings.drilldownReports,
          googleSearchConsole: platformAnalyticsSettings.googleSearchConsole,
          googleAnalytics4: platformAnalyticsSettings.googleAnalytics4,
          metaPixel: platformAnalyticsSettings.metaPixel,
          storefrontConversion: platformAnalyticsSettings.storefrontConversion,
          grossMargin: platformAnalyticsSettings.grossMargin,
        })
        .from(platformAnalyticsSettings)
        .where(eq(platformAnalyticsSettings.id, true))
        .limit(1),
    );
    return resolveAnalyticsFeatureSettings(row);
  } catch (error) {
    // Deploying code before the migration must not take every merchant's
    // dashboard down. Defaults preserve today's shipped behaviour; planned
    // collection features remain off.
    logError("getPlatformAnalyticsFeatures failed", error);
    return { ...DEFAULT_ANALYTICS_FEATURE_SETTINGS };
  }
}
