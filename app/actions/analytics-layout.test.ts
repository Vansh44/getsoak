/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(),
}));
vi.mock("@/lib/locations/scope", () => ({
  getViewerLocations: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { revalidatePath } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { getViewerLocations } from "@/lib/locations/scope";
import {
  resetAnalyticsDashboardLayout,
  saveAnalyticsDashboardLayout,
} from "./analytics-layout";

const VIEWER = {
  userId: "user-1",
  profile: { role: "superadmin" },
  isSuperadmin: true,
  isPlatformAdmin: false,
  permissions: {},
  storeId: "store-1",
};

function layout(
  items: Array<{ widgetId: string; size?: string }>,
  id = "overview",
) {
  return {
    defaultRevision: 2,
    sections: [
      {
        id,
        title: "Overview",
        hidden: false,
        items: items.map((item) => ({
          widgetId: item.widgetId,
          size: item.size ?? "compact",
        })),
      },
    ],
  };
}

describe("analytics layout actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    vi.mocked(getViewerContext).mockResolvedValue(VIEWER as any);
    vi.mocked(getViewerLocations).mockResolvedValue(null);
  });

  it("requires Analytics view access", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      ...VIEWER,
      isSuperadmin: false,
      permissions: {},
    } as any);
    const result = await saveAnalyticsDashboardLayout(
      layout([{ widgetId: "metric_orders" }]),
      null,
    );
    expect(result.error).toMatch(/access/i);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("rejects unknown, duplicate, and currently unauthorized cards", async () => {
    expect(
      (
        await saveAnalyticsDashboardLayout(
          layout([{ widgetId: "made_up" }]),
          null,
        )
      ).error,
    ).toMatch(/valid/i);
    expect(
      (
        await saveAnalyticsDashboardLayout(
          layout([
            { widgetId: "metric_orders" },
            { widgetId: "metric_orders" },
          ]),
          null,
        )
      ).error,
    ).toMatch(/valid/i);

    vi.mocked(getViewerContext).mockResolvedValue({
      ...VIEWER,
      isSuperadmin: false,
      permissions: { analytics: ["view"] },
    } as any);
    vi.mocked(getViewerLocations).mockResolvedValue(["loc-1"]);
    expect(
      (
        await saveAnalyticsDashboardLayout(
          layout([{ widgetId: "metric_customers" }]),
          null,
        )
      ).error,
    ).toMatch(/valid/i);
  });

  it("creates a personal row keyed from the authenticated viewer", async () => {
    const result = await saveAnalyticsDashboardLayout(
      layout([{ widgetId: "metric_orders" }, { widgetId: "metric_revenue" }]),
      null,
    );
    expect(result.success).toBe(true);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      adminUserId: "user-1",
      schemaVersion: 2,
      layout: {
        defaultRevision: 2,
        sections: [
          {
            id: "overview",
            title: "Overview",
            hidden: false,
            items: [
              { widgetId: "metric_orders", size: "compact" },
              { widgetId: "metric_revenue", size: "compact" },
            ],
          },
        ],
      },
    });
    expect(dbHolder.current.calls.forUpdate).toEqual(["update"]);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/analytics");
  });

  it("preserves cards made dormant by current permissions and location scope", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      ...VIEWER,
      isSuperadmin: false,
      permissions: { analytics: ["view"] },
    } as any);
    vi.mocked(getViewerLocations).mockResolvedValue(["loc-1"]);
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            updatedAt: "2026-08-18T00:00:00.000Z",
            layout: {
              defaultRevision: 1,
              widgetIds: [
                "metric_orders",
                "metric_customers",
                "blog_approvals",
              ],
            },
          },
        ],
      ],
    });

    const result = await saveAnalyticsDashboardLayout(
      layout([{ widgetId: "metric_revenue" }]),
      "2026-08-18T00:00:00.000Z",
    );
    expect(result.success).toBe(true);
    expect(dbHolder.current.calls.values[0].layout.sections[0].items).toEqual([
      { widgetId: "metric_revenue", size: "compact" },
      { widgetId: "metric_customers", size: "compact" },
      { widgetId: "blog_approvals", size: "compact" },
    ]);
  });

  it("refuses to overwrite a newer layout", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            updatedAt: "2026-08-18T01:00:00.000Z",
            layout: { defaultRevision: 1, widgetIds: [] },
          },
        ],
      ],
    });
    const result = await saveAnalyticsDashboardLayout(
      layout([{ widgetId: "metric_orders" }]),
      "2026-08-18T00:00:00.000Z",
    );
    expect(result.conflict).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("reset deletes the override so the viewer follows product defaults", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ updatedAt: "2026-08-18T00:00:00.000Z" }]],
    });
    const result = await resetAnalyticsDashboardLayout(
      "2026-08-18T00:00:00.000Z",
    );
    expect(result).toMatchObject({ success: true, updatedAt: null });
    expect(dbHolder.current.calls.delete).toHaveLength(1);
  });
});
