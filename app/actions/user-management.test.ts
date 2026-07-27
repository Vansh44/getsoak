/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/auth/firebase-users", () => ({
  deleteAuthUser: vi.fn(async () => {}),
  updateAuthUser: vi.fn(async () => {}),
  generatePasswordResetLink: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/firebase-claims", () => ({
  setUserClaims: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
// The caller-role gate reads via withUser, target reads/updates via withService
// — both share this one mock db, so selectQueue is consumed in call order.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  changeUserRole,
  deleteUser,
  toggleUserSuspension,
} from "./user-management";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { getServerUser } from "@/lib/auth/server-user";

const CALLER_ID = "superadmin-123";
const superadmin = [{ role: "superadmin" }];

function setup(selectQueue: any[][]) {
  dbHolder.current = makeDbMock({ selectQueue });
}

describe("User Management Actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: CALLER_ID,
      email: "super@example.com",
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    vi.mocked(deleteAuthUser).mockResolvedValue();
    vi.mocked(setUserClaims).mockResolvedValue();
    // Default: caller is superadmin, target is a plain member.
    setup([superadmin, [{ role: "member" }]]);
  });

  describe("deleteUser", () => {
    it("should fail if caller is not authenticated", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Not authenticated");
    });

    it("should fail if caller is not superadmin", async () => {
      setup([[{ role: "member" }]]); // caller gate → member
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Unauthorized");
    });

    it("should delete user if caller is superadmin", async () => {
      const result = await deleteUser("user-1");
      expect((result as any).success).toBe(true);
      // Profile row removed (Cloud SQL) AND the login (Identity Platform).
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(deleteAuthUser).toHaveBeenCalledWith("user-1");
    });

    it("should not allow deleting your own account", async () => {
      setup([superadmin]); // only the gate read happens before the self-check
      const result = await deleteUser(CALLER_ID);
      expect(result.error).toBe("You cannot delete your own account.");
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });

    it("should not allow deleting the last superadmin", async () => {
      // gate, target is superadmin, count = 1.
      setup([superadmin, [{ role: "superadmin" }], [{ n: 1 }]]);
      const result = await deleteUser("user-1");
      expect(result.error).toBe("Cannot delete the last superadmin.");
      expect(deleteAuthUser).not.toHaveBeenCalled();
    });
  });

  describe("changeUserRole", () => {
    it("should fail if role is invalid", async () => {
      // gate, roles-table lookup empty → unknown non-builtin role rejected.
      setup([superadmin, []]);
      const result = await changeUserRole("user-1", "invalid-role");
      expect(result.error).toBe("Invalid role");
    });

    it("should change role successfully and sync the claim", async () => {
      // gate, roles lookup (member is builtin so [] is fine), target=member.
      setup([superadmin, [], [{ role: "member" }]]);
      const result = await changeUserRole("user-1", "member");
      expect((result as any).success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ role: "member" });
      expect(setUserClaims).toHaveBeenCalledWith("user-1", { role: "member" });
    });
  });

  describe("toggleUserSuspension", () => {
    it("should toggle suspension successfully", async () => {
      setup([superadmin]);
      const result = await toggleUserSuspension("user-1", true);
      expect((result as any).success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ isSuspended: true });
    });
  });
});
