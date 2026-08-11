/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./firebase-admin", () => ({ getFirebaseAdminAuth: vi.fn() }));

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  mintSessionCookie,
  verifySessionCookie,
  sessionCookieOptions,
} from "./session-cookie";
import { getFirebaseAdminAuth } from "./firebase-admin";

function makeAuth() {
  return {
    verifyIdToken: vi.fn().mockResolvedValue({ uid: "u1" }),
    createSessionCookie: vi.fn().mockResolvedValue("session-cookie-value"),
    verifySessionCookie: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mintSessionCookie", () => {
  it("verifies the ID token, then mints a 14-day session cookie", async () => {
    const auth = makeAuth();
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(auth as any);

    const cookie = await mintSessionCookie("id-token");
    expect(cookie).toBe("session-cookie-value");
    expect(auth.verifyIdToken).toHaveBeenCalledWith("id-token");
    expect(auth.createSessionCookie).toHaveBeenCalledWith("id-token", {
      expiresIn: SESSION_MAX_AGE_SECONDS * 1000,
    });
  });

  it("returns null when Identity Platform isn't configured", async () => {
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(null);
    expect(await mintSessionCookie("id-token")).toBeNull();
  });

  it("returns null (never mints) when the ID token is invalid", async () => {
    const auth = makeAuth();
    auth.verifyIdToken.mockRejectedValue(new Error("bad token"));
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(auth as any);

    expect(await mintSessionCookie("forged")).toBeNull();
    expect(auth.createSessionCookie).not.toHaveBeenCalled();
  });
});

describe("verifySessionCookie", () => {
  it("decodes uid, email, phone and the role / force_password_reset claims", async () => {
    const auth = makeAuth();
    auth.verifySessionCookie.mockResolvedValue({
      uid: "u1",
      email: "a@b.com",
      email_verified: true,
      phone_number: "+15551234567",
      name: "Ada",
      role: "superadmin",
      force_password_reset: true,
    });
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(auth as any);

    const user = await verifySessionCookie("cookie");
    expect(user).toEqual({
      uid: "u1",
      email: "a@b.com",
      emailConfirmed: true,
      phone: "+15551234567",
      phoneConfirmed: true,
      name: "Ada",
      claims: { role: "superadmin", forcePasswordReset: true },
    });
  });

  it("falls back to the legacy user_role claim key", async () => {
    const auth = makeAuth();
    auth.verifySessionCookie.mockResolvedValue({
      uid: "u1",
      email: null,
      user_role: "member",
    });
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(auth as any);

    const user = await verifySessionCookie("cookie");
    expect(user?.claims).toEqual({ role: "member", forcePasswordReset: false });
    expect(user?.emailConfirmed).toBe(false);
    expect(user?.phoneConfirmed).toBe(false);
  });

  it("returns null for a missing cookie without touching the SDK", async () => {
    const auth = makeAuth();
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(auth as any);
    expect(await verifySessionCookie(undefined)).toBeNull();
    expect(auth.verifySessionCookie).not.toHaveBeenCalled();
  });

  it("returns null when not configured or when verification throws", async () => {
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(null);
    expect(await verifySessionCookie("cookie")).toBeNull();

    const auth = makeAuth();
    auth.verifySessionCookie.mockRejectedValue(new Error("expired"));
    vi.mocked(getFirebaseAdminAuth).mockReturnValue(auth as any);
    expect(await verifySessionCookie("cookie")).toBeNull();
  });
});

describe("sessionCookieOptions", () => {
  it("scopes the cookie to the shared parent domain for a store subdomain", () => {
    const opts = sessionCookieOptions("shop.storemink.com");
    expect(opts.domain).toBe(".storemink.com");
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("omits the domain on localhost (host-only cookie)", () => {
    const opts = sessionCookieOptions("localhost:3000");
    expect(opts.domain).toBeUndefined();
  });

  it("exposes a stable cookie name distinct from Supabase's", () => {
    expect(SESSION_COOKIE).toBe("sm_session");
    expect(SESSION_COOKIE.startsWith("sb-")).toBe(false);
  });
});
