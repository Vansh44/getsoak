/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  storeAllowsPlanFeature: vi.fn(async () => true),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  createUserGroup,
  updateUserGroup,
  deleteUserGroup,
  setGroupMembers,
} from "./user-group-actions";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { storeAllowsPlanFeature } from "@/lib/plans/entitlements";

const STORE = "a0000000-0000-4000-8000-000000000001";

const validForm = {
  name: "  VIPs  ",
  description: "  big spenders  ",
  color: "",
};

// user-group-actions.ts is admin-only CRUD over the user_groups table plus a
// membership replace (clear-then-insert, now in one withService transaction).
// The "users" section's manage right gates access.
describe("user-group-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "g1" }] });
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "user-1",
      email: "admin@example.com",
    });
    vi.mocked(storeAllowsPlanFeature).mockResolvedValue(true);
  });

  describe("createUserGroup", () => {
    it("rejects when caller lacks users.manage", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await createUserGroup(validForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    it("rejects empty name", async () => {
      const result = await createUserGroup({ ...validForm, name: "   " });
      expect(result.error).toMatch(/group name is required/i);
    });

    it("inserts a normalised row and returns the created data", async () => {
      const result = await createUserGroup(validForm);
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: "g1" });
      const inserted = dbHolder.current.calls.values[0];
      expect(inserted.name).toBe("VIPs");
      expect(inserted.description).toBe("big spenders");
      expect(inserted.color).toBe("blue");
      expect(inserted.createdBy).toBe("user-1");
    });

    it("stores a null description when blank", async () => {
      await createUserGroup({ ...validForm, description: "   " });
      expect(dbHolder.current.calls.values[0].description).toBeNull();
    });

    it("returns friendly error on unique-violation", async () => {
      dbHolder.current.db.insert = vi.fn(() => {
        throw Object.assign(new Error("dup"), { code: "23505" });
      });
      const result = await createUserGroup(validForm);
      expect(result.error).toMatch(/already exists/i);
    });

    it("returns the message on a generic DB error", async () => {
      dbHolder.current.db.insert = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await createUserGroup(validForm);
      expect(result.error).toBe("boom");
    });
  });

  describe("updateUserGroup", () => {
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await updateUserGroup("g1", validForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    it("rejects empty name", async () => {
      const result = await updateUserGroup("g1", { ...validForm, name: "  " });
      expect(result.error).toMatch(/group name is required/i);
    });

    it("updates a normalised row by id (store scoped)", async () => {
      const result = await updateUserGroup("g1", validForm);
      expect(result.success).toBe(true);
      const updated = dbHolder.current.calls.set[0];
      expect(updated.name).toBe("VIPs");
      expect(updated.description).toBe("big spenders");
      expect(updated.color).toBe("blue");
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });

    it("keeps existing groups editable after a downgrade", async () => {
      vi.mocked(storeAllowsPlanFeature).mockResolvedValue(false);
      const result = await updateUserGroup("g1", validForm);
      expect(result.success).toBe(true);
      expect(storeAllowsPlanFeature).not.toHaveBeenCalled();
    });

    it("returns friendly error on unique-violation", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw Object.assign(new Error("dup"), { code: "23505" });
      });
      const result = await updateUserGroup("g1", validForm);
      expect(result.error).toMatch(/already exists/i);
    });

    it("returns the message on a generic DB error", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await updateUserGroup("g1", validForm);
      expect(result.error).toBe("boom");
    });
  });

  describe("deleteUserGroup", () => {
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await deleteUserGroup("g1");
      expect(result.error).toMatch(/not authenticated/i);
    });

    it("deletes the group by id (store scoped)", async () => {
      const result = await deleteUserGroup("g1");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });

    it("allows deleting an existing group after a downgrade", async () => {
      vi.mocked(storeAllowsPlanFeature).mockResolvedValue(false);
      const result = await deleteUserGroup("g1");
      expect(result.success).toBe(true);
      expect(storeAllowsPlanFeature).not.toHaveBeenCalled();
    });

    it("returns the message on a DB error", async () => {
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await deleteUserGroup("g1");
      expect(result.error).toBe("boom");
    });
  });

  // setGroupMembers replaces the group's whole membership: verify the group
  // belongs to the store, clear all rows, then insert the (de-duped, truthy)
  // selection — all in one transaction. select #1 = the ownership check.
  describe("setGroupMembers", () => {
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await setGroupMembers("g1", ["c1"]);
      expect(result.error).toMatch(/not authenticated/i);
    });

    it("errors when the group isn't in the acting store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] }); // ownership check empty
      const result = await setGroupMembers("g1", ["c1"]);
      expect(result.error).toMatch(/group not found/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("clears existing members then inserts the selection", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ id: "g1" }]] });
      const result = await setGroupMembers("g1", ["c1", "c2"]);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(dbHolder.current.calls.values[0]).toEqual([
        { groupId: "g1", userId: "c1", addedBy: "user-1", storeId: STORE },
        { groupId: "g1", userId: "c2", addedBy: "user-1", storeId: STORE },
      ]);
    });

    it("keeps existing memberships editable after a downgrade", async () => {
      vi.mocked(storeAllowsPlanFeature).mockResolvedValue(false);
      dbHolder.current = makeDbMock({ selectQueue: [[{ id: "g1" }]] });

      const result = await setGroupMembers("g1", ["c1"]);

      expect(result.success).toBe(true);
      expect(storeAllowsPlanFeature).not.toHaveBeenCalled();
    });

    it("clears only when the selection is empty", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ id: "g1" }]] });
      const result = await setGroupMembers("g1", []);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("de-dupes and drops falsy ids before insert", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ id: "g1" }]] });
      await setGroupMembers("g1", ["c1", "c1", "", "c2"]);
      expect(dbHolder.current.calls.values[0]).toEqual([
        { groupId: "g1", userId: "c1", addedBy: "user-1", storeId: STORE },
        { groupId: "g1", userId: "c2", addedBy: "user-1", storeId: STORE },
      ]);
    });

    it("returns error when the clear step fails", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ id: "g1" }]] });
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("delete failed");
      });
      const result = await setGroupMembers("g1", ["c1"]);
      expect(result.error).toBe("delete failed");
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });
  });
});
