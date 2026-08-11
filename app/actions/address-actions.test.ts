/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => STORE),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) => fn(dbHolder.current.db)),
  withService: vi.fn((fn: any) => fn(dbHolder.current.db)),
  withAnon: vi.fn((fn: any) => fn(dbHolder.current.db)),
}));

import {
  getMyAddresses,
  saveAddress,
  upsertAddress,
  setDefaultAddress,
  deleteAddress,
} from "./address-actions";
import { getServerUser } from "@/lib/auth/server-user";

const STORE = "a0000000-0000-4000-8000-000000000001";

const serverUser = {
  id: "user-1",
  email: "ada@example.com",
  emailConfirmed: true,
  phone: null,
  phoneConfirmed: true,
  metadata: {},
};

const validInput = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "9999999999",
  addressLine1: "1 Analytical Engine Rd",
  city: "London",
  state: "England",
  postalCode: "SW1",
  country: "UK",
};

// address-actions.ts — the customer saved-address book. Every read/write runs
// through withUser under the shopper's own identity (own-row RLS) with
// explicit user_id scoping on top.
describe("address-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "new" }] });
    vi.mocked(getServerUser).mockResolvedValue(serverUser);
  });

  describe("getMyAddresses", () => {
    it("returns an empty list when signed out", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      expect(await getMyAddresses()).toEqual([]);
      expect(dbHolder.current.calls.select).toHaveLength(0);
    });

    it("returns the caller's own addresses", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ id: "a1", city: "London" }]],
      });
      const result = await getMyAddresses();
      expect(result).toEqual([{ id: "a1", city: "London" }]);
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });
  });

  describe("saveAddress", () => {
    it("rejects when signed out", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await saveAddress(validInput);
      expect(result.error).toMatch(/signed in/i);
    });

    it("rejects a missing required field", async () => {
      const result = await saveAddress({ ...validInput, city: "  " });
      expect(result.error).toMatch(/city is required/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("inserts a new address as the default and clears the old default", async () => {
      // Dedup lookup finds nothing → a fresh insert.
      dbHolder.current = makeDbMock({
        returning: [{ id: "new" }],
        selectQueue: [[]],
      });
      const result = await saveAddress(validInput);
      expect(result.success).toBe(true);
      expect(result.id).toBe("new");
      // Old defaults cleared for this user first.
      expect(dbHolder.current.calls.set[0]).toEqual({ isDefault: false });
      // New row inserted, marked default, scoped to the user + store.
      expect(dbHolder.current.calls.values[0]).toMatchObject({
        userId: "user-1",
        storeId: STORE,
        isDefault: true,
        city: "London",
      });
    });

    it("updates an identical existing address instead of duplicating it", async () => {
      // Dedup lookup finds a matching row.
      dbHolder.current = makeDbMock({
        selectQueue: [[{ id: "existing" }]],
      });
      const result = await saveAddress(validInput);
      expect(result.success).toBe(true);
      expect(result.id).toBe("existing");
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      // Two updates: clear-default + the dedup update on the existing row.
      expect(dbHolder.current.calls.set).toHaveLength(2);
      expect(dbHolder.current.calls.set[1]).toMatchObject({
        isDefault: true,
        city: "London",
      });
    });
  });

  describe("upsertAddress", () => {
    it("rejects when signed out", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await upsertAddress(validInput);
      expect(result.error).toMatch(/signed in/i);
    });

    it("rejects a missing required field", async () => {
      const result = await upsertAddress({ ...validInput, state: "" });
      expect(result.error).toMatch(/state is required/i);
    });

    it("adds a first address as the default", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ id: "new" }],
        selectQueue: [[{ n: 0 }]],
      });
      const result = await upsertAddress(validInput);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.values[0].isDefault).toBe(true);
    });

    it("adds a subsequent address as non-default", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ id: "new2" }],
        selectQueue: [[{ n: 2 }]],
      });
      await upsertAddress(validInput);
      expect(dbHolder.current.calls.values[0].isDefault).toBe(false);
    });

    it("edits an existing address by id without inserting", async () => {
      const result = await upsertAddress(validInput, "addr-9");
      expect(result.success).toBe(true);
      expect(result.id).toBe("addr-9");
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        userId: "user-1",
        city: "London",
      });
      // Where carries id + user_id (owner scope).
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });
  });

  describe("setDefaultAddress", () => {
    it("rejects an empty id", async () => {
      const result = await setDefaultAddress("  ");
      expect(result.error).toMatch(/invalid/i);
    });

    it("rejects when signed out", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await setDefaultAddress("a1");
      expect(result.error).toMatch(/signed in/i);
    });

    it("clears the old default and sets the chosen one, scoped to the owner", async () => {
      const result = await setDefaultAddress("a1");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set).toEqual([
        { isDefault: false },
        { isDefault: true },
      ]);
      expect(dbHolder.current.calls.where).toHaveLength(2);
    });
  });

  describe("deleteAddress", () => {
    it("rejects an empty id", async () => {
      const result = await deleteAddress("  ");
      expect(result.error).toMatch(/invalid/i);
    });

    it("rejects when signed out", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await deleteAddress("a1");
      expect(result.error).toMatch(/signed in/i);
    });

    it("deletes an address scoped to the owner", async () => {
      const result = await deleteAddress("a1");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });
  });
});
