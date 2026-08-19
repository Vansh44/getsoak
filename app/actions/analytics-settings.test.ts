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
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));

import { updateTag } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { saveAnalyticsTimeZone } from "./analytics-settings";

function form(timeZone: string) {
  const data = new FormData();
  data.set("timeZone", timeZone);
  return data;
}

describe("analytics settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({
      selectQueue: [[{ settings: { business: { city: "Delhi" }, brand: {} } }]],
    });
    vi.mocked(getViewerContext).mockResolvedValue({
      userId: "user-1",
      profile: { role: "superadmin" },
      isSuperadmin: true,
      isPlatformAdmin: false,
      permissions: {},
      storeId: "store-1",
    } as any);
  });

  it("requires settings.manage", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      profile: { role: "staff" },
      isSuperadmin: false,
      permissions: { settings: ["view"] },
      storeId: "store-1",
    } as any);
    const result = await saveAnalyticsTimeZone({}, form("Europe/London"));
    expect(result.error).toMatch(/permission/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects a non-IANA zone before writing", async () => {
    const result = await saveAnalyticsTimeZone({}, form("GMT+5"));
    expect(result.error).toMatch(/valid business time zone/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("merges the zone without erasing existing business or store settings", async () => {
    const result = await saveAnalyticsTimeZone({}, form("Europe/London"));
    expect(result.success).toMatch(/saved/i);
    expect(dbHolder.current.calls.set[0].settings).toEqual({
      business: { city: "Delhi", timeZone: "Europe/London" },
      brand: {},
    });
    expect(updateTag).toHaveBeenCalledWith("stores");
  });
});
