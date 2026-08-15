/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/auth/firebase-users", () => ({
  createAuthUser: vi.fn(async () => "new-user"),
  deleteAuthUser: vi.fn(async () => {}),
  authErrorCode: vi.fn(() => undefined),
}));
vi.mock("@/lib/auth/firebase-claims", () => ({
  setUserClaims: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("./location-actions", () => ({ setAdminLocations: vi.fn() }));
vi.mock("@/lib/email/layout", () => ({
  wrapBrandedEmail: vi.fn((s: string) => s),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrandById: vi.fn(async () => ({
    name: "WholeSip",
    domain: "wholesip.com",
  })),
}));
// vi.hoisted ensures `resendSend` exists at the moment the `vi.mock("resend")`
// factory runs (mocks are hoisted above imports). The factory must return a
// real constructor (class), because invite-user.ts uses `new Resend(...)`.
const { resendSend } = vi.hoisted(() => ({
  resendSend: vi.fn().mockResolvedValue({}),
}));
vi.mock("resend", () => {
  class Resend {
    emails: { send: typeof resendSend };
    constructor() {
      this.emails = { send: resendSend };
    }
  }
  return { Resend };
});

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { inviteUser } from "./invite-user";
import { createAuthUser, deleteAuthUser } from "@/lib/auth/firebase-users";
import { setUserClaims } from "@/lib/auth/firebase-claims";
import { getServerUser } from "@/lib/auth/server-user";
import { setAdminLocations } from "./location-actions";

function makeFormData(fields: Record<string, string | null | undefined>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) fd.set(k, v);
  }
  return fd;
}

// The caller-role gate reads via withUser (select #1 = role + store_id), the
// email-collision check via withService (select #2). superadmin, in-store.
function superadminCaller(existingEmail = false) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [{ role: "superadmin", store_id: "store-1" }],
      existingEmail ? [{ id: "existing" }] : [],
    ],
  });
}

// invite-user.ts — superadmin-only action that creates a new dashboard user.
// Profile reads/writes are on Drizzle; the auth account (Identity Platform) +
// custom claims + the Resend email stay on their providers.
describe("inviteUser", () => {
  const validForm = {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    role: "member",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resendSend.mockClear();
    resendSend.mockResolvedValue({});
    process.env.RESEND_API_KEY = "re_actual_key";
    superadminCaller();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "caller-1",
      email: "super@example.com",
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    vi.mocked(createAuthUser).mockResolvedValue("new-user");
    vi.mocked(deleteAuthUser).mockResolvedValue();
    vi.mocked(setUserClaims).mockResolvedValue();
    // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
    vi.mocked(setAdminLocations).mockResolvedValue({ success: true });
  });

  it("rejects empty first name", async () => {
    const result = await inviteUser(
      makeFormData({ ...validForm, firstName: "" }),
    );
    expect(result.error).toMatch(/first name/i);
  });

  it("rejects malformed email", async () => {
    const result = await inviteUser(makeFormData({ ...validForm, email: "x" }));
    expect(result.error).toMatch(/valid email/i);
  });

  it("rejects unknown role", async () => {
    const result = await inviteUser(
      makeFormData({ ...validForm, role: "ghost" }),
    );
    expect(result.error).toMatch(/invalid role/i);
  });

  it("rejects unauthenticated callers", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/not authenticated/i);
  });

  it("rejects non-superadmin callers", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ role: "member", store_id: "store-1" }]],
    });
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/unauthorized|superadmin/i);
  });

  it("rejects when a profile with that email already exists", async () => {
    superadminCaller(true);
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/already exists/i);
    expect(createAuthUser).not.toHaveBeenCalled();
  });

  it("creates the auth user + profile, sets claims, and sends invite email", async () => {
    const result = await inviteUser(makeFormData(validForm));
    expect(result.success).toBe(true);
    expect(createAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "ada@example.com",
        emailVerified: true,
      }),
    );
    // Profile upserted with the new auth id + inviter's store.
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      id: "new-user",
      email: "ada@example.com",
      storeId: "store-1",
      invitedBy: "caller-1",
    });
    // Role + force-reset mirrored into the auth token as custom claims.
    expect(setUserClaims).toHaveBeenCalledWith("new-user", {
      role: "member",
      forcePasswordReset: true,
    });
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("cleans up the auth user if profile insert fails", async () => {
    superadminCaller();
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("no");
    });
    const result = await inviteUser(makeFormData(validForm));
    expect(result.error).toMatch(/failed to create user profile/i);
    expect(deleteAuthUser).toHaveBeenCalledWith("new-user");
  });

  it("falls back gracefully without RESEND_API_KEY (dev mode)", async () => {
    process.env.RESEND_API_KEY = "placeholder";
    const result = await inviteUser(makeFormData(validForm));
    expect(result.success).toBe(true);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("escapes HTML in the invitee name within the email body", async () => {
    await inviteUser(
      makeFormData({ ...validForm, firstName: "<img/onerror=x>" }),
    );
    const sentHtml = resendSend.mock.calls[0][0].html as string;
    expect(sentHtml).not.toContain("<img/onerror");
    expect(sentHtml).toContain("&lt;img");
  });

  // ---------------------------------------------------------------------------
  // Location scope at invite time. The machinery (admin_locations,
  // getViewerLocations, setAdminLocations) already existed — but the only way to
  // set it was an action with no caller, so in practice every invited admin saw
  // every shop.
  // ---------------------------------------------------------------------------
  describe("inviteUser — location scope", () => {
    function formWith(locationIds: string[], role = "member") {
      const fd = new FormData();
      fd.set("firstName", "Ada");
      fd.set("email", "ada@example.com");
      fd.set("role", role);
      // ★ append, not set — the field is multi-value: one person can cover
      // several shops.
      for (const id of locationIds) fd.append("locationIds", id);
      return fd;
    }

    it("restricts the new admin to the locations given", async () => {
      await inviteUser(formWith(["loc-1", "loc-2"]));
      expect(setAdminLocations).toHaveBeenCalledWith("new-user", [
        "loc-1",
        "loc-2",
      ]);
    });

    // ★ EMPTY = UNRESTRICTED, the existing contract (null = all). So the field
    // being ignored invites exactly the admin this form always did — no
    // behaviour change for anyone who never touches it.
    it("leaves an admin unrestricted when none are given", async () => {
      await inviteUser(formWith([]));
      expect(setAdminLocations).not.toHaveBeenCalled();
    });

    // A superadmin sees everything by definition; writing a scope for one would
    // store a restriction that getViewerLocations then ignores, which is worse
    // than storing nothing — the staff list would show a limit that isn't real.
    it("never scopes a superadmin", async () => {
      await inviteUser(formWith(["loc-1"], "superadmin"));
      expect(setAdminLocations).not.toHaveBeenCalled();
    });

    // ⚠ Best-effort: a failure here leaves them unrestricted, which is visible
    // on the staff list and fixable in one click. Failing the invite would leave
    // an orphaned auth user instead.
    it("still creates the admin when the scope write fails", async () => {
      vi.mocked(setAdminLocations).mockRejectedValue(new Error("db down"));
      const r = await inviteUser(formWith(["loc-1"]));
      expect(r.error).toBeUndefined();
    });
  });
});
