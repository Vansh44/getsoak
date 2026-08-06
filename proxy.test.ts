/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The proxy gates dashboard/auth routes on the verified Firebase session cookie.
// Mock the verifier so we can drive signed-in / signed-out + claim outcomes.
vi.mock("@/lib/auth/session-cookie", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, verifySessionCookie: vi.fn() };
});

import { proxy } from "./proxy";
import { verifySessionCookie } from "@/lib/auth/session-cookie";

function req(url: string, host = "shop.storemink.com") {
  return new NextRequest(new URL(url), { headers: { host } });
}

function signedIn(claims: {
  role?: string | null;
  forcePasswordReset?: boolean;
}) {
  vi.mocked(verifySessionCookie).mockResolvedValue({
    uid: "u1",
    email: "a@b.com",
    phone: null,
    phoneConfirmed: false,
    name: null,
    claims: {
      role: claims.role ?? null,
      forcePasswordReset: claims.forcePasswordReset ?? false,
    },
  });
}

const loc = (res: any) => res.headers.get("location");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifySessionCookie).mockResolvedValue(null); // signed out by default
});

describe("proxy — store-host session gate", () => {
  it("redirects an unauthenticated /dashboard visit to /auth/login", async () => {
    const res = await proxy(req("https://shop.storemink.com/dashboard"));
    expect(res.status).toBe(307);
    expect(loc(res)).toContain("/auth/login");
  });

  it("lets a normal admin into /dashboard", async () => {
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/dashboard"));
    expect(loc(res)).toBeNull();
  });

  it("forces a password reset when the claim is set", async () => {
    signedIn({ role: "member", forcePasswordReset: true });
    const res = await proxy(req("https://shop.storemink.com/dashboard/orders"));
    expect(loc(res)).toContain("/auth/set-password");
  });

  // ★ The proxy no longer gates /dashboard/users or /dashboard/media on a role
  // CLAIM. It used to demand `role === "superadmin"`, but `createStore` writes
  // that role to the `admins` TABLE and never mints the claim — so every
  // wizard-created owner was bounced off their own Customers page while the
  // sidebar (which reads the database) happily showed the link. The route had
  // also been repurposed from staff management to the SHOPPER list, so locking it
  // to the owner contradicted the `users` permission existing at all.
  //
  // Both pages call requireSectionAccess() server-side, so authorisation still
  // happens — in one place, against the database, instead of two that disagreed.
  it("does not gate /dashboard/users on a role claim", async () => {
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/dashboard/users"));
    expect(loc(res)).toBeNull();
  });

  it("does not gate /dashboard/media on a role claim", async () => {
    // The same gate covered media, so an owner could not open it either.
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/dashboard/media"));
    expect(loc(res)).toBeNull();
  });

  it("lets an owner with NO role claim reach Customers — the reported bug", async () => {
    // Exactly the signup-created owner: superadmin in the database, no claim in
    // the session cookie.
    signedIn({});
    const res = await proxy(req("https://shop.storemink.com/dashboard/users"));
    expect(loc(res)).toBeNull();
  });

  it("still keeps POS staff out of the dashboard entirely", async () => {
    // The remaining claim checks are ALLOWLISTS, which is why they survive an
    // absent claim safely. This one must keep working.
    for (const role of ["cashier", "manager"]) {
      signedIn({ role });
      const res = await proxy(
        req("https://shop.storemink.com/dashboard/users"),
      );
      expect(loc(res), role).toContain("/pos");
    }
  });

  it("bounces a signed-in user away from /auth/login", async () => {
    signedIn({ role: "member" });
    const res = await proxy(req("https://shop.storemink.com/auth/login"));
    expect(loc(res)).toContain("/dashboard");
  });

  it("requires auth for /auth/set-password", async () => {
    const res = await proxy(
      req("https://shop.storemink.com/auth/set-password"),
    );
    expect(loc(res)).toContain("/auth/login");
  });

  it("does NOT gate the storefront (no auth check)", async () => {
    const res = await proxy(req("https://shop.storemink.com/shop"));
    expect(loc(res)).toBeNull();
    expect(verifySessionCookie).not.toHaveBeenCalled();
  });
});

describe("proxy — host routing (unchanged)", () => {
  it("passes static assets through untouched", async () => {
    const res = await proxy(req("https://shop.storemink.com/themes/x/a.webp"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(loc(res)).toBeNull();
  });

  it("rewrites platform-host paths into /platform/*", async () => {
    const res = await proxy(
      req("https://storemink.com/pricing", "storemink.com"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toContain("/platform");
  });

  it("rewrites the reserved themes host into the public catalog", async () => {
    const res = await proxy(
      req("https://themes.storemink.com/", "themes.storemink.com"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toContain("/themes");
    expect(res.headers.get("x-middleware-rewrite")).not.toContain("/platform");
    expect(verifySessionCookie).not.toHaveBeenCalled();
  });
});
