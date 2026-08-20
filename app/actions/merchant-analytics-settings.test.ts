/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/analytics/platform-feature-store", () => ({
  getPlatformAnalyticsFeatures: vi.fn(),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));

import { updateTag } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { saveMerchantAnalyticsSettings } from "./merchant-analytics-settings";

const enabledFeatures = {
  coreDashboard: true,
  dashboardCustomization: true,
  drilldownReports: true,
  googleSearchConsole: true,
  googleAnalytics4: true,
  metaPixel: true,
  storefrontConversion: false,
  grossMargin: false,
};

function useStore(plan = "pro", settings: Record<string, unknown> = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [[{ plan, plan_expires_at: null, settings }]],
  });
}

describe("merchant Analytics settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore();
    vi.mocked(getViewerContext).mockResolvedValue({
      userId: "admin-1",
      profile: { role: "superadmin" },
      isSuperadmin: true,
      permissions: {},
      storeId: "store-1",
    } as any);
    vi.mocked(getPlatformAnalyticsFeatures).mockResolvedValue(enabledFeatures);
  });

  it("requires settings.manage", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      userId: "admin-1",
      profile: { role: "staff" },
      isSuperadmin: false,
      permissions: { settings: ["view"] },
      storeId: "store-1",
    } as any);

    const result = await saveMerchantAnalyticsSettings({
      ga4MeasurementId: "G-ABC12345",
      ga4Enabled: true,
      metaPixelId: "1234567890",
      metaPixelEnabled: true,
    });

    expect("error" in result && result.error).toMatch(/permission/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects malformed IDs before persistence", async () => {
    const result = await saveMerchantAnalyticsSettings({
      ga4MeasurementId: "UA-OLD",
      ga4Enabled: true,
      metaPixelId: "pixel-script",
      metaPixelEnabled: true,
    });

    expect("error" in result && result.error).toMatch(/GA4 Measurement ID/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("never grants pixels to a lower plan", async () => {
    useStore("basic");
    const result = await saveMerchantAnalyticsSettings({
      ga4MeasurementId: "G-ABC12345",
      ga4Enabled: true,
      metaPixelId: "1234567890",
      metaPixelEnabled: true,
    });

    expect("error" in result && result.error).toMatch(/Pro plan/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("merges valid Pro settings without erasing other store settings", async () => {
    useStore("pro", {
      brand: { primaryColor: "#123456" },
      marketing: { unrelated: "keep" },
    });
    const result = await saveMerchantAnalyticsSettings({
      ga4MeasurementId: " g-abc12345 ",
      ga4Enabled: true,
      metaPixelId: "1234567890",
      metaPixelEnabled: true,
    });

    expect(result).toMatchObject({
      success: true,
      settings: {
        ga4MeasurementId: "G-ABC12345",
        ga4Enabled: true,
        metaPixelId: "1234567890",
        metaPixelEnabled: true,
      },
    });
    expect(dbHolder.current.calls.set[0].settings).toMatchObject({
      brand: { primaryColor: "#123456" },
      marketing: {
        unrelated: "keep",
        ga4MeasurementId: "G-ABC12345",
        ga4Enabled: true,
        metaPixelId: "1234567890",
        metaPixelEnabled: true,
      },
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
  });
});
