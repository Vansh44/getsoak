/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase 6: getServerUser verifies the Firebase session cookie (Identity
// Platform). Mock the cookie jar and the verifier — no Supabase involved.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("./session-cookie", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, verifySessionCookie: vi.fn() };
});

import { getServerUser, getServerUserId } from "./server-user";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionCookie } from "./session-cookie";

const cookieStore = { get: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cookies).mockResolvedValue(cookieStore as any);
  cookieStore.get.mockReturnValue({ value: "fb-cookie" });
});

describe("getServerUser", () => {
  it("returns null when there is no session cookie", async () => {
    cookieStore.get.mockReturnValue(undefined);
    vi.mocked(verifySessionCookie).mockResolvedValue(null);
    expect(await getServerUser()).toBeNull();
    expect(await getServerUserId()).toBeNull();
  });

  it("returns null when the session cookie is invalid/expired", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue(null);
    expect(await getServerUser()).toBeNull();
  });

  it("maps a verified session onto the ServerUser shape", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue({
      uid: "u-123",
      email: "a@b.com",
      emailConfirmed: true,
      phone: "+911234567890",
      phoneConfirmed: true,
      name: "Ada",
      claims: { role: "superadmin", forcePasswordReset: false },
    });

    expect(await getServerUser()).toEqual({
      id: "u-123",
      email: "a@b.com",
      emailConfirmed: true,
      phone: "+911234567890",
      phoneConfirmed: true,
      metadata: { name: "Ada", full_name: "Ada" },
    });
    expect(cookieStore.get).toHaveBeenCalledWith(SESSION_COOKIE);
  });

  it("normalises a nameless user to empty metadata", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue({
      uid: "u-1",
      email: null,
      emailConfirmed: false,
      phone: null,
      phoneConfirmed: false,
      name: null,
      claims: { role: null, forcePasswordReset: false },
    });
    const u = await getServerUser();
    expect(u).toEqual({
      id: "u-1",
      email: null,
      emailConfirmed: false,
      phone: null,
      phoneConfirmed: false,
      metadata: {},
    });
  });

  it("getServerUserId returns just the id", async () => {
    vi.mocked(verifySessionCookie).mockResolvedValue({
      uid: "u-9",
      email: null,
      emailConfirmed: false,
      phone: null,
      phoneConfirmed: false,
      name: null,
      claims: { role: null, forcePasswordReset: false },
    });
    expect(await getServerUserId()).toBe("u-9");
  });
});
