import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYTICS_FEATURE_SETTINGS,
  analyticsFeatureAllowed,
  resolveAnalyticsFeatureSettings,
} from "./features";

describe("analytics feature settings", () => {
  it("keeps shipped modules on and planned collection modules off by default", () => {
    expect(DEFAULT_ANALYTICS_FEATURE_SETTINGS.coreDashboard).toBe(true);
    expect(DEFAULT_ANALYTICS_FEATURE_SETTINGS.googleSearchConsole).toBe(true);
    expect(DEFAULT_ANALYTICS_FEATURE_SETTINGS.googleAnalytics4).toBe(false);
    expect(DEFAULT_ANALYTICS_FEATURE_SETTINGS.metaPixel).toBe(false);
  });

  it("accepts booleans only and fills missing settings from safe defaults", () => {
    expect(
      resolveAnalyticsFeatureSettings({
        coreDashboard: false,
        googleAnalytics4: true,
        metaPixel: "true",
      }),
    ).toMatchObject({
      coreDashboard: false,
      googleAnalytics4: true,
      metaPixel: false,
      drilldownReports: true,
    });
  });

  it("never grants a Pro analytics module to a lower plan", () => {
    const enabled = resolveAnalyticsFeatureSettings({
      googleAnalytics4: true,
    });
    expect(analyticsFeatureAllowed(enabled, "googleAnalytics4", "basic")).toBe(
      false,
    );
    expect(analyticsFeatureAllowed(enabled, "googleAnalytics4", "pro")).toBe(
      true,
    );
  });
});
