/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(),
}));

// `queue` serves a DIFFERENT result per withService call, which
// getViewerLocationNames needs (ids, then names). Empty queue falls back to
// `rows`, so every existing test is untouched.
const dbHolder = vi.hoisted(() => ({
  rows: [] as any[],
  queue: [] as any[][],
  throws: false,
  throwOnCall: 0,
  calls: 0,
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async () => {
    dbHolder.calls += 1;
    if (dbHolder.throws) throw new Error("connection reset");
    if (dbHolder.throwOnCall === dbHolder.calls) throw new Error("db down");
    if (dbHolder.queue.length > 0) return dbHolder.queue.shift();
    return dbHolder.rows;
  }),
}));

import { getViewerContext } from "@/app/dashboard/lib/access";
import {
  getViewerLocations,
  scopeAllows,
  getViewerLocationNames,
} from "./scope";

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
  // ⚠ Reset the new fields too, or a queue set in one test serves the next.
  dbHolder.queue = [];
  dbHolder.throwOnCall = 0;
  dbHolder.calls = 0;
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

// ---------------------------------------------------------------------------
// The topbar tag's read. A SEPARATE query from getViewerLocations, which
// answers a SECURITY question on every scoped page and stays a bare id list —
// joining names onto it would make every order page pay for a header label.
// ---------------------------------------------------------------------------
describe("getViewerLocationNames", () => {
  it("returns nothing for an unrestricted viewer, so the tag hides", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      isSuperadmin: true,
    } as never);
    await expect(getViewerLocationNames()).resolves.toEqual([]);
  });

  // ⚠ An EMPTY scope means "assigned to nothing that still exists" — a real
  // state, NOT unrestricted. There are no names to show either way, but the
  // distinction lives in getViewerLocations ([] vs null) and must stay there.
  it("returns nothing for a viewer assigned to nothing that exists", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      isSuperadmin: false,
      profile: { id: "a1" },
    } as never);
    dbHolder.queue = [[]];
    await expect(getViewerLocationNames()).resolves.toEqual([]);
  });

  it("names the shops a restricted viewer covers", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      isSuperadmin: false,
      profile: { id: "a1" },
    } as never);
    dbHolder.queue = [
      [{ location_id: "loc-1" }, { location_id: "loc-2" }],
      [
        { id: "loc-1", name: "Delhi" },
        { id: "loc-2", name: "Jaipur" },
      ],
    ];
    await expect(getViewerLocationNames()).resolves.toEqual([
      { id: "loc-1", name: "Delhi" },
      { id: "loc-2", name: "Jaipur" },
    ]);
  });

  // The tag is an explanation, not a gate — losing it costs a label, and the
  // scope itself is enforced by getViewerLocations regardless.
  it("loses the label rather than throwing when the name read fails", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      isSuperadmin: false,
      profile: { id: "a1" },
    } as never);
    dbHolder.queue = [[{ location_id: "loc-1" }]];
    dbHolder.throwOnCall = 2; // the NAME read, after the ids resolved fine
    await expect(getViewerLocationNames()).resolves.toEqual([]);
  });
});
