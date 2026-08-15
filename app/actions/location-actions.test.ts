/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
  isStoreSuperadmin: vi.fn(),
}));
// Unrestricted by default — the state every existing test was written under.
vi.mock("@/lib/locations/scope", () => ({
  getViewerLocations: vi.fn(async () => null),
}));

// getStoreLocations is only used by createLocation for its return value.
vi.mock("@/lib/pos/locations", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, getStoreLocations: vi.fn(async () => []) };
});

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { revalidateTag } from "next/cache";
import {
  getManagerIdentity,
  isStoreSuperadmin,
} from "@/app/dashboard/lib/access";
import { getViewerLocations } from "@/lib/locations/scope";
import { getStoreLocations } from "@/lib/pos/locations";
import {
  enablePos,
  disablePos,
  createLocation,
  updateLocation,
  deleteLocation,
  saveLocationCapabilities,
  listLocations,
} from "./location-actions";

const IDENTITY = { uid: "u1", email: "a@b.c" };
const FREE = { settings: {}, plan: "free", plan_expires_at: null };
const PRO_OFF = { settings: {}, plan: "pro", plan_expires_at: null };
const PRO_ON = {
  settings: { features: { "pos.enabled": true } },
  plan: "pro",
  plan_expires_at: null,
};

// Queue the db.select() results, in the order the action consumes them.
function useSelects(queue: any[][], executeQueue: any[][] = []) {
  dbHolder.current = makeDbMock({ selectQueue: queue, executeQueue });
}

describe("location-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — but setting one
    // BEFORE it is worse than not setting it, because clearAllMocks then wipes
    // it. Every restoration goes after.
    vi.mocked(isStoreSuperadmin).mockResolvedValue(true);
    vi.mocked(getViewerLocations).mockResolvedValue(null);
    vi.mocked(getManagerIdentity).mockResolvedValue(IDENTITY as any);
    vi.mocked(getStoreLocations).mockResolvedValue([]);
    useSelects([]);
  });

  describe("enablePos", () => {
    it("rejects callers without pos manage permission", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const r = await enablePos();
      expect(r.error).toMatch(/permission/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("refuses on a non-Pro plan", async () => {
      useSelects([[FREE]]);
      const r = await enablePos();
      expect(r.error).toMatch(/pro plan/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("enables POS on Pro: writes pos.enabled, ensures a location, busts cache", async () => {
      useSelects([[PRO_OFF]]);
      const r = await enablePos();
      expect(r.success).toBe(true);
      // Ensured the default location via the DB helper.
      expect(dbHolder.current.calls.execute).toHaveLength(1);
      // Wrote pos.enabled=true into settings.features.
      const set = dbHolder.current.calls.set[0];
      expect(set.settings.features["pos.enabled"]).toBe(true);
      expect(revalidateTag).toHaveBeenCalled();
    });
  });

  describe("disablePos", () => {
    it("turns POS off without a plan check (writes pos.enabled=false)", async () => {
      useSelects([[FREE]]);
      const r = await disablePos();
      expect(r.success).toBe(true);
      const set = dbHolder.current.calls.set[0];
      expect(set.settings.features["pos.enabled"]).toBe(false);
      // Disabling never touches the default-location helper.
      expect(dbHolder.current.calls.execute).toHaveLength(0);
    });
  });

  describe("createLocation", () => {
    it("rejects unauthorized callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toMatch(/permission/i);
    });

    // Locations are no longer a POS feature: a warehouse that only fulfils
    // online orders needs no till, and requiring one would mean switching on a
    // feature you don't want to reach a feature you do.
    it("allows a location on Pro even with POS switched off", async () => {
      useSelects([[PRO_OFF], [{ n: 1 }]]);
      const r = await createLocation({ name: "Warehouse", type: "warehouse" });
      expect(r.error).toBeUndefined();
      expect(dbHolder.current.calls.insert).toHaveLength(1);
    });

    // Creation defaults come from the type — and nothing customer-facing is
    // ever on by default (docs/locations-ia.md §6.2).
    it("seeds capabilities from the type", async () => {
      useSelects([[PRO_OFF], [{ n: 1 }]]);
      await createLocation({ name: "Warehouse", type: "warehouse" });
      const caps = dbHolder.current.calls.values[0].capabilities;
      expect(caps).toMatchObject({
        pos: false,
        online_fulfil: true,
        pickup: false,
        returns: false,
      });
    });

    it("refuses on a non-Pro plan", async () => {
      useSelects([[FREE]]);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toMatch(/pro plan/i);
    });

    it("enforces the plan location cap", async () => {
      // Pro includes 2 locations; already at 2, paying for none → blocked.
      useSelects([[PRO_ON], [{ n: 2 }], [{ billed_locations: 0 }]]);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toMatch(/includes 2 locations/i);
      // It now points at where you buy one, rather than "coming soon".
      expect(r.error).toMatch(/₹1,000\/month/);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    // ★ THE PAID ALLOWANCE IS ADDITIVE (roadmap Step 5). Pro includes 2; a
    // store paying for 1 may hold 3. Without this the merchant is charged for
    // a location the cap still refuses to let them create.
    it("allows a location bought on top of the included allowance", async () => {
      useSelects([[PRO_ON], [{ n: 2 }], [{ billed_locations: 1 }]]);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toBeUndefined();
      expect(dbHolder.current.calls.insert).toHaveLength(1);
    });

    it("still stops at included + billed", async () => {
      useSelects([[PRO_ON], [{ n: 3 }], [{ billed_locations: 1 }]]);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toMatch(/using all 3 of your locations/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    // ★ The count comes from the subscription row, never the caller. A client
    // that could name it would be naming a free location (invariant 5).
    it("treats a missing subscription row as nothing paid for", async () => {
      useSelects([[PRO_ON], [{ n: 2 }], []]);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toMatch(/includes 2 locations/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("requires a name", async () => {
      useSelects([[PRO_ON]]);
      const r = await createLocation({ name: "   " });
      expect(r.error).toMatch(/name/i);
    });

    it("creates a non-default, store-scoped location under the cap", async () => {
      useSelects([[PRO_ON], [{ n: 1 }]]);
      vi.mocked(getStoreLocations).mockResolvedValue([
        { id: "loc-2", name: "Delhi", isDefault: false } as any,
      ]);
      const r = await createLocation({
        name: "Delhi",
        type: "shop",
        stateCode: "07",
      });
      expect(r.error).toBeUndefined();
      expect(r.location?.id).toBe("loc-2");
      const values = dbHolder.current.calls.values[0];
      expect(values.storeId).toBe("store-1");
      expect(values.isDefault).toBe(false);
      expect(values.stateCode).toBe("07");
    });
  });

  describe("updateLocation", () => {
    it("updates a location store-scoped", async () => {
      useSelects([[PRO_ON]]);
      const r = await updateLocation("loc-2", { name: "Delhi CP" });
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0].name).toBe("Delhi CP");
    });
  });

  describe("deleteLocation", () => {
    it("refuses to delete the main (default) location", async () => {
      useSelects([[PRO_ON], [{ is_default: true }], [{ n: 2 }]]);
      const r = await deleteLocation("loc-1");
      expect(r.error).toMatch(/main location/i);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    it("refuses to delete the last location", async () => {
      useSelects([[PRO_ON], [{ is_default: false }], [{ n: 1 }]]);
      const r = await deleteLocation("loc-2");
      expect(r.error).toMatch(/at least one/i);
    });

    it("refuses to delete a location that still holds stock", async () => {
      useSelects([[PRO_ON], [{ is_default: false }], [{ n: 2 }], [{ n: 1 }]]);
      const r = await deleteLocation("loc-2");
      expect(r.error).toMatch(/still has stock/i);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    it("deletes an empty non-default location", async () => {
      useSelects([[PRO_ON], [{ is_default: false }], [{ n: 2 }], [{ n: 0 }]]);
      const r = await deleteLocation("loc-2");
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
    });
  });

  describe("saveLocationCapabilities", () => {
    // Two locations: "here" (the one being edited) and "other".
    const rowsFor = (here: any, other: any) => [
      [
        { id: "loc-1", type: "shop", capabilities: here },
        { id: "loc-2", type: "warehouse", capabilities: other },
      ],
    ];
    const FULFILS = { online_fulfil: true };
    const NOT = { online_fulfil: false };

    it("rejects unauthorized callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const r = await saveLocationCapabilities("loc-1", { pickup: true });
      expect(r.error).toMatch(/permission/i);
    });

    it("refuses on a non-Pro plan", async () => {
      useSelects([[FREE]]);
      const r = await saveLocationCapabilities("loc-1", { pickup: true });
      expect(r.error).toMatch(/pro plan/i);
    });

    it("refuses a location from another store", async () => {
      useSelects([[PRO_ON], [[]]]);
      const r = await saveLocationCapabilities("not-mine", { pickup: true });
      expect(r.error).toMatch(/not found/i);
    });

    it("saves a capability change", async () => {
      useSelects([[PRO_ON], ...rowsFor({ pos: true }, FULFILS)]);
      const r = await saveLocationCapabilities("loc-1", { pickup: true });
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0].capabilities).toMatchObject({
        pos: true,
        pickup: true,
      });
    });

    // RULE 1 — the stored state may never disagree with what locationCan reports.
    // Pickup without POS is collection at a counter with nobody behind it.
    it("forces off a capability whose dependency is off", async () => {
      useSelects([[PRO_ON], ...rowsFor({ pos: false }, FULFILS)]);
      const r = await saveLocationCapabilities("loc-1", {
        pickup: true,
        returns: true,
      });
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0].capabilities).toMatchObject({
        pickup: false,
        returns: false,
      });
    });

    it("switching POS off takes pickup and returns with it", async () => {
      useSelects([
        [PRO_ON],
        ...rowsFor({ pos: true, pickup: true, returns: true }, FULFILS),
      ]);
      await saveLocationCapabilities("loc-1", { pos: false });
      expect(dbHolder.current.calls.set[0].capabilities).toMatchObject({
        pos: false,
        pickup: false,
        returns: false,
      });
    });

    // RULE 2 — the store would advertise products it has no way to ship, and
    // every checkout would fail with no visible cause.
    it("refuses to switch off the LAST online-fulfilment location", async () => {
      useSelects([[PRO_ON], ...rowsFor(FULFILS, NOT)]);
      const r = await saveLocationCapabilities("loc-1", {
        online_fulfil: false,
      });
      expect(r.error).toMatch(/only location that fulfils/i);
      expect(dbHolder.current.calls.set).toHaveLength(0);
    });

    it("allows switching it off when another location still fulfils", async () => {
      useSelects([[PRO_ON], ...rowsFor(FULFILS, FULFILS)]);
      const r = await saveLocationCapabilities("loc-1", {
        online_fulfil: false,
      });
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0].capabilities.online_fulfil).toBe(
        false,
      );
    });

    it("ignores unknown keys and non-booleans from the client", async () => {
      useSelects([[PRO_ON], ...rowsFor({ pos: true }, FULFILS)]);
      await saveLocationCapabilities("loc-1", {
        teleport: true,
        pos: "yes",
      } as never);
      const saved = dbHolder.current.calls.set[0].capabilities;
      expect("teleport" in saved).toBe(false);
      expect(saved.pos).toBe(true); // unchanged by the non-boolean
    });
  });

  // ---------------------------------------------------------------------------
  // Location scope on the dashboard (§23).
  // ---------------------------------------------------------------------------
  describe("location scope", () => {
    // ★★ A capability decides whether a shop sells, fulfils online orders or
    // takes returns — it reshapes the BUSINESS, not one shop's day. The
    // `locations` grant is what a branch manager needs to READ their own shop;
    // letting it also switch online fulfilment off would let one manager stop
    // the website taking orders.
    it("refuses a capability change from a non-owner", async () => {
      vi.mocked(isStoreSuperadmin).mockResolvedValue(false);
      const r = await saveLocationCapabilities("loc-1", { pos: true });
      expect(r.error).toMatch(/only the store owner/i);
    });

    // ★ A restricted admin has no reason to read another branch's address,
    // capabilities or stock — listing them would put back exactly what scoping
    // the orders and inventory pages took away.
    it("lists only the shops a restricted admin is assigned to", async () => {
      vi.mocked(getViewerLocations).mockResolvedValue(["loc-1"]);
      vi.mocked(getStoreLocations).mockResolvedValue([
        { id: "loc-1", name: "Delhi" },
        { id: "loc-2", name: "Jaipur" },
      ] as never);
      const r = await listLocations();
      expect(r.locations.map((l) => l.id)).toEqual(["loc-1"]);
    });

    it("lists every shop for an unrestricted viewer", async () => {
      vi.mocked(getViewerLocations).mockResolvedValue(null);
      vi.mocked(getStoreLocations).mockResolvedValue([
        { id: "loc-1", name: "Delhi" },
        { id: "loc-2", name: "Jaipur" },
      ] as never);
      const r = await listLocations();
      expect(r.locations.map((l) => l.id)).toEqual(["loc-1", "loc-2"]);
    });

    // ⚠ EMPTY is "assigned to nothing that still exists" — a real state, and NOT
    // unrestricted. It must show nothing rather than everything.
    it("shows nothing for an admin assigned to nothing that exists", async () => {
      vi.mocked(getViewerLocations).mockResolvedValue([]);
      vi.mocked(getStoreLocations).mockResolvedValue([
        { id: "loc-1", name: "Delhi" },
      ] as never);
      const r = await listLocations();
      expect(r.locations).toEqual([]);
    });
  });
});
