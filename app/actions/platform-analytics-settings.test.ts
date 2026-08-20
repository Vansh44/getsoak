/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { revalidatePath } from "next/cache";
import { getPlatformViewer } from "@/app/actions/platform";
import { savePlatformAnalyticsSettings } from "./platform-analytics-settings";

const SETTINGS = {
  coreDashboard: true,
  dashboardCustomization: true,
  drilldownReports: true,
  googleSearchConsole: true,
  googleAnalytics4: false,
  metaPixel: false,
  storefrontConversion: false,
  grossMargin: false,
};

describe("platform Analytics settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(getPlatformViewer).mockResolvedValue({
      email: "owner@storemink.com",
      role: "superadmin",
    });
  });

  it("allows only platform superadmins to change availability", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue({
      email: "member@storemink.com",
      role: "member",
    });
    const result = await savePlatformAnalyticsSettings(SETTINGS);
    expect("error" in result && result.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects partial or unknown setting shapes", async () => {
    expect(
      "error" in (await savePlatformAnalyticsSettings({ coreDashboard: true })),
    ).toBe(true);
    expect(
      "error" in
        (await savePlatformAnalyticsSettings({
          ...SETTINGS,
          surprise: true,
        })),
    ).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("upserts the singleton and refreshes operator and merchant surfaces", async () => {
    const result = await savePlatformAnalyticsSettings({
      ...SETTINGS,
      googleSearchConsole: false,
      googleAnalytics4: true,
    });
    expect(result).toMatchObject({
      success: true,
      settings: {
        googleSearchConsole: false,
        googleAnalytics4: true,
      },
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      id: true,
      googleSearchConsole: false,
      googleAnalytics4: true,
      updatedBy: "owner@storemink.com",
    });
    expect(dbHolder.current.calls.onConflict).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith(
      "/platform/dashboard/(console)/analytics",
      "page",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/analytics");
  });
});
