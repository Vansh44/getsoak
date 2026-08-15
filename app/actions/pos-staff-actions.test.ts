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
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/pos/locations", () => ({
  getStoreLocations: vi.fn(async () => [
    { id: "loc-1", name: "Main" },
    { id: "loc-2", name: "Delhi" },
  ]),
}));
vi.mock("@/lib/pos/devices", () => ({
  getAuthorizedDevice: vi.fn(async () => null),
}));
// Both return Promise<void> in production — the actions call .catch() on them.
vi.mock("@/lib/auth/firebase-claims", () => ({
  setUserClaims: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/firebase-users", () => ({
  deleteAuthUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrandById: vi.fn(async () => ({
    name: "Echos",
    domain: "echos.com",
  })),
}));
vi.mock("@/lib/email/layout", () => ({
  wrapBrandedEmail: (html: string) => html,
}));
vi.mock("@/lib/email/sender", () => ({ fromAddress: () => "a@b.c" }));
vi.mock("@/lib/site", () => ({
  getStoreUrl: async () => "https://echos.storemink.com",
}));
// The invite link is built from the REQUEST host so it's clickable in dev.
vi.mock("@/lib/request-url", () => ({
  getRequestOrigin: vi.fn(async () => "http://echos.localhost:3000"),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: vi.fn(async () => ({})) };
  },
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getServerUser } from "@/lib/auth/server-user";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { getAuthorizedDevice } from "@/lib/pos/devices";
import {
  listStaff,
  inviteStaff,
  updateStaff,
  deleteStaff,
  getInviteInfo,
  completeStaffRegistration,
} from "./pos-staff-actions";

const ID = { uid: "u1", email: "a@b.c" };
function useSelects(q: any[][]) {
  dbHolder.current = makeDbMock({ selectQueue: q });
}
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

describe("pos-staff-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getManagerIdentity).mockResolvedValue(ID as any);
    useSelects([]);
  });

  describe("listStaff", () => {
    it("rejects unauthorized callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      expect((await listStaff()).error).toMatch(/not authorized/i);
    });

    it("maps staff → status + locations, and never selects pin_hash", async () => {
      useSelects([
        [
          {
            id: "s1",
            name: "Priya",
            email: "p@x.com",
            role: "cashier",
            status: "active",
            active: true,
          },
        ],
        [{ staff_id: "s1", location_id: "loc-1" }],
      ]);
      const r = await listStaff();
      expect(r.staff[0]).toMatchObject({
        id: "s1",
        name: "Priya",
        email: "p@x.com",
        role: "cashier",
        status: "active",
        locationIds: ["loc-1"],
      });
      expect("pin_hash" in (r.staff[0] as object)).toBe(false);
      // The PIN hash is never even projected in the query.
      expect(Object.keys(dbHolder.current.calls.select[0] ?? {})).not.toContain(
        "pin_hash",
      );
    });
  });

  describe("inviteStaff", () => {
    it("rejects unauthorized callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const r = await inviteStaff({
        name: "x",
        email: "x@y.com",
        role: "cashier",
        locationIds: ["loc-1"],
      });
      expect(r.error).toMatch(/permission/i);
    });

    it("validates name, email, role and location", async () => {
      const base = {
        name: "x",
        email: "x@y.com",
        role: "cashier",
        locationIds: ["loc-1"],
      };
      expect((await inviteStaff({ ...base, name: " " })).error).toMatch(
        /name/i,
      );
      expect((await inviteStaff({ ...base, email: "nope" })).error).toMatch(
        /valid email/i,
      );
      expect((await inviteStaff({ ...base, role: "boss" })).error).toMatch(
        /role/i,
      );
      expect(
        (await inviteStaff({ ...base, locationIds: ["x"] })).error,
      ).toMatch(/location/i);
    });

    it("creates an invited staff row with a token + location assignments", async () => {
      const r = await inviteStaff({
        name: "Priya",
        email: "  Priya@Example.COM ",
        role: "manager",
        locationIds: ["loc-1", "loc-2"],
      });
      expect(r.error).toBeUndefined();

      const vals = dbHolder.current.calls.values[0];
      expect(vals.email).toBe("priya@example.com"); // normalised
      expect(vals.role).toBe("manager");
      expect(vals.status).toBe("invited");
      expect(vals.inviteToken).toBeTruthy();
      expect(vals.storeId).toBe("store-1");
      // No PIN is ever set by the admin — the staff chooses it at registration.
      expect(vals.pinHash).toBeUndefined();

      const locVals = dbHolder.current.calls.values[1];
      expect(locVals).toHaveLength(2);
      expect(locVals[0].isPrimary).toBe(true);
    });
  });

  describe("updateStaff", () => {
    it("updates the row, replaces locations, and re-mirrors the role claim", async () => {
      // The trailing select resolves the linked Firebase uid for the claim.
      useSelects([[{ user_id: "fb-uid-1" }]]);
      const r = await updateStaff("s1", {
        name: "Priya K",
        role: "manager",
        locationIds: ["loc-2"],
      });
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0].name).toBe("Priya K");
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(setUserClaims).toHaveBeenCalledWith("fb-uid-1", {
        role: "manager",
      });
    });
  });

  describe("deleteStaff", () => {
    it("deletes store-scoped", async () => {
      const r = await deleteStaff("s1");
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
    });
  });

  describe("getInviteInfo", () => {
    it("rejects an unknown token", async () => {
      useSelects([[]]);
      expect(await getInviteInfo("nope")).toMatchObject({
        error: expect.stringMatching(/no longer valid/i),
      });
    });

    it("rejects an already-registered invite", async () => {
      useSelects([
        [
          {
            name: "P",
            email: "p@x.com",
            role: "cashier",
            status: "active",
            invite_expires_at: future(),
          },
        ],
      ]);
      expect(await getInviteInfo("t")).toMatchObject({
        error: expect.stringMatching(/no longer valid/i),
      });
    });

    it("rejects an expired invite", async () => {
      useSelects([
        [
          {
            name: "P",
            email: "p@x.com",
            role: "cashier",
            status: "invited",
            invite_expires_at: past(),
          },
        ],
      ]);
      expect(await getInviteInfo("t")).toMatchObject({
        error: expect.stringMatching(/expired/i),
      });
    });

    it("returns the invite details for a valid token", async () => {
      useSelects([
        [
          {
            name: "Priya",
            email: "p@x.com",
            role: "manager",
            status: "invited",
            invite_expires_at: future(),
          },
        ],
      ]);
      expect(await getInviteInfo("t")).toMatchObject({
        name: "Priya",
        email: "p@x.com",
        role: "manager",
      });
    });
  });

  describe("completeStaffRegistration", () => {
    const staffRow = {
      id: "s1",
      email: "p@x.com",
      role: "cashier",
      status: "invited",
      invite_expires_at: future(),
    };

    it("requires a signed-in (just-created) account", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null as any);
      expect((await completeStaffRegistration("t", "12345678")).error).toMatch(
        /creating your account/i,
      );
    });

    it("requires a verified phone", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "p@x.com",
        phoneConfirmed: false,
      } as any);
      expect((await completeStaffRegistration("t", "12345678")).error).toMatch(
        /verify your phone/i,
      );
    });

    it("requires an 8-digit PIN", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "p@x.com",
        phoneConfirmed: true,
      } as any);
      expect((await completeStaffRegistration("t", "1234")).error).toMatch(
        /8 digits/i,
      );
    });

    it("refuses when the account email doesn't match the invite", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "someone@else.com",
        phoneConfirmed: true,
      } as any);
      useSelects([[staffRow]]);
      expect((await completeStaffRegistration("t", "12345678")).error).toMatch(
        /email address your invitation/i,
      );
    });

    it("refuses an expired invite", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "p@x.com",
        phoneConfirmed: true,
      } as any);
      useSelects([[{ ...staffRow, invite_expires_at: past() }]]);
      expect((await completeStaffRegistration("t", "12345678")).error).toMatch(
        /expired/i,
      );
    });

    // ★★ AN ADMIN MUST NOT COMPLETE THIS. Finishing sets a cashier/manager
    // claim, and proxy.ts sends those from /dashboard straight to /pos — so an
    // owner who invites themselves "to try the till" would lose the dashboard
    // for EVERY store they administer. Claims are per-user, not per-store,
    // which is why the check looks across all of them.
    it("refuses when the account is a dashboard admin", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "p@x.com",
        phoneConfirmed: true,
      } as any);
      // 1st select = the staff row, 2nd = the admins lookup.
      useSelects([[staffRow], [{ id: "fb1" }]]);

      const r = await completeStaffRegistration("t", "12345678");
      expect(r.error).toMatch(/already a dashboard admin/i);
      // Nothing written, and crucially no claim set — the claim IS the lockout.
      expect(dbHolder.current.calls.set).toHaveLength(0);
      expect(setUserClaims).not.toHaveBeenCalled();
    });

    // Wrongly refusing costs a retry; wrongly allowing costs a dashboard.
    it("fails CLOSED when the admin lookup errors", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "p@x.com",
        phoneConfirmed: true,
      } as any);
      dbHolder.current = makeDbMock({ selectQueue: [[staffRow]] });
      const realSelect = dbHolder.current.db.select;
      let n = 0;
      dbHolder.current.db.select = (...args: any[]) => {
        n += 1;
        if (n === 2) throw new Error("db down");
        return realSelect(...args);
      };

      const r = await completeStaffRegistration("t", "12345678");
      expect(r.error).toMatch(/couldn't verify/i);
      expect(setUserClaims).not.toHaveBeenCalled();
    });

    it("links the account, stores the PIN hash, activates, and sets the role claim", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "P@X.com", // case-insensitive match
        phoneConfirmed: true,
      } as any);
      // 2nd entry = the admins lookup finding nothing, which is what lets a
      // genuine staff member through. Seeded explicitly rather than relying on
      // an exhausted queue.
      useSelects([[staffRow], []]);

      const r = await completeStaffRegistration("t", "12345678");
      expect(r.success).toBe(true);

      const set = dbHolder.current.calls.set[0];
      expect(set.userId).toBe("fb1");
      expect(set.pinHash).toMatch(/^scrypt\$/);
      expect(set.status).toBe("active");
      // The single-use token is consumed.
      expect(set.inviteToken).toBeNull();
      // The role claim is what keeps POS staff out of /dashboard.
      expect(setUserClaims).toHaveBeenCalledWith("fb1", { role: "cashier" });
    });

    // Staff register on their PERSONAL phone from the emailed link. That must
    // SUCCEED (identity is portable; only selling is device-bound) and report
    // deviceAuthorized:false so the UI shows a confirmation, not a rejection.
    it("succeeds on an unauthorized device and reports deviceAuthorized:false", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "p@x.com",
        phoneConfirmed: true,
      } as any);
      vi.mocked(getAuthorizedDevice).mockResolvedValue(null);
      useSelects([[staffRow]]);

      const r = await completeStaffRegistration("t", "12345678");
      expect(r.success).toBe(true);
      expect(r.deviceAuthorized).toBe(false);
    });

    // Registering on the shop's authorized tablet → straight into the register.
    it("reports deviceAuthorized:true when registered on an authorized device", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "fb1",
        email: "p@x.com",
        phoneConfirmed: true,
      } as any);
      vi.mocked(getAuthorizedDevice).mockResolvedValue({
        deviceId: "d1",
        locationId: "loc-1",
      });
      useSelects([[staffRow]]);

      const r = await completeStaffRegistration("t", "12345678");
      expect(r.success).toBe(true);
      expect(r.deviceAuthorized).toBe(true);
    });
  });
});
