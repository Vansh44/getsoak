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
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getStoreLocations } from "@/lib/pos/locations";
import {
  enablePos,
  disablePos,
  createLocation,
  updateLocation,
  deleteLocation,
} from "./pos-location-actions";

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

describe("pos-location-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it("refuses when POS isn't enabled", async () => {
      useSelects([[PRO_OFF]]);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toMatch(/enable pos/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("refuses on a non-Pro plan", async () => {
      useSelects([[FREE]]);
      const r = await createLocation({ name: "Delhi" });
      expect(r.error).toMatch(/pro plan/i);
    });

    it("enforces the plan location cap", async () => {
      // Pro includes 2 locations; already at 2 → blocked.
      useSelects([[PRO_ON], [{ n: 2 }]]);
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
});
