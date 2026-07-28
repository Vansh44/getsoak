/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ rows: [] as any[], throws: false }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async () => {
    if (dbHolder.throws) throw new Error("connection reset");
    return dbHolder.rows;
  }),
}));

import { getViewerContext } from "@/app/dashboard/lib/access";
import { getViewerLocations, scopeAllows } from "./scope";

const viewer = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  userEmail: "a@b.c",
  storeId: "store-1",
  profile: { email: "a@b.c", role: "member", store_id: "store-1" },
  isSuperadmin: false,
  isPlatformAdmin: false,
  permissions: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.rows = [];
  dbHolder.throws = false;
  vi.mocked(getViewerContext).mockResolvedValue(viewer() as any);
});

describe("getViewerLocations", () => {
  // THE settled decision: owners see everything.
  it("is unrestricted for a superadmin", async () => {
    vi.mocked(getViewerContext).mockResolvedValue(
      viewer({ isSuperadmin: true }) as any,
    );
    expect(await getViewerLocations()).toBeNull();
  });

  it("is unrestricted for a platform operator", async () => {
    vi.mocked(getViewerContext).mockResolvedValue(
      viewer({ isPlatformAdmin: true }) as any,
    );
    expect(await getViewerLocations()).toBeNull();
  });

  // Absence is not restriction — otherwise this feature would blank every
  // existing admin's dashboard the day it shipped.
  it("is unrestricted for an admin with no bindings", async () => {
    dbHolder.rows = [];
    expect(await getViewerLocations()).toBeNull();
  });

  it("returns the bound locations for restricted staff", async () => {
    dbHolder.rows = [{ location_id: "loc-1" }, { location_id: "loc-2" }];
    expect(await getViewerLocations()).toEqual(["loc-1", "loc-2"]);
  });

  // The access.ts rule: never turn a DB error into an access decision.
  // Unrestricted is the safe direction — it preserves today's behaviour rather
  // than blanking a working dashboard.
  it("is unrestricted when the lookup fails", async () => {
    dbHolder.throws = true;
    expect(await getViewerLocations()).toBeNull();
  });

  it("is unrestricted when the access context itself errored", async () => {
    vi.mocked(getViewerContext).mockResolvedValue(
      viewer({ dbError: true, profile: null }) as any,
    );
    expect(await getViewerLocations()).toBeNull();
  });
});

describe("scopeAllows", () => {
  it("allows everything when unrestricted", () => {
    expect(scopeAllows(null, "loc-9")).toBe(true);
    expect(scopeAllows(null, null)).toBe(true);
  });

  it("allows only the bound locations", () => {
    expect(scopeAllows(["loc-1"], "loc-1")).toBe(true);
    expect(scopeAllows(["loc-1"], "loc-2")).toBe(false);
  });

  // An order belonging to no shop (every online order until fulfilment routing
  // lands) must stay visible, or location-bound staff lose the entire online
  // order book.
  it("allows a location-less record", () => {
    expect(scopeAllows(["loc-1"], null)).toBe(true);
    expect(scopeAllows(["loc-1"], undefined)).toBe(true);
  });

  // Assigned only to locations that have since been deleted: show NOTHING.
  // Treating this as unrestricted would silently promote them.
  it("allows nothing with an empty scope", () => {
    expect(scopeAllows([], "loc-1")).toBe(false);
  });
});
