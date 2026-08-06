/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session-cookie", () => ({
  SESSION_COOKIE: "sm_session",
  sessionCookieOptions: vi.fn((host: string | null) => ({
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    domain: host?.endsWith("storemink.com") ? ".storemink.com" : undefined,
    maxAge: 60 * 60 * 24 * 14,
  })),
}));

import { POST } from "./route";
import { sessionCookieOptions } from "@/lib/auth/session-cookie";

function req(headers: Record<string, string> = {}): any {
  return { headers: new Headers(headers) };
}

// Clears the httpOnly server cookie. The delete must carry the SAME
// domain/path attributes the cookie was set with, or the cross-subdomain
// (.storemink.com) cookie is not removed at all — the browser keeps it and the
// merchant stays signed in after pressing Sign out.
describe("POST /api/auth/signout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers ok", async () => {
    const res = await POST(req({ host: "acme.storemink.com" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("expires the session cookie", async () => {
    const res = await POST(req({ host: "acme.storemink.com" }));

    const cookie = res.cookies.get("sm_session");
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });

  it("deletes with the SAME domain the cookie was set with", async () => {
    // The reason this route reads the host at all.
    const res = await POST(req({ host: "acme.storemink.com" }));

    expect(sessionCookieOptions).toHaveBeenCalledWith("acme.storemink.com");
    expect(res.cookies.get("sm_session")?.domain).toBe(".storemink.com");
  });

  it("deletes host-only on a merchant's custom domain", async () => {
    const res = await POST(req({ host: "acme.com" }));

    expect(res.cookies.get("sm_session")?.domain).toBeUndefined();
    expect(res.cookies.get("sm_session")?.maxAge).toBe(0);
  });

  it("prefers the forwarded host behind the load balancer", async () => {
    await POST(
      req({ "x-forwarded-host": "acme.storemink.com", host: "internal:8080" }),
    );

    expect(sessionCookieOptions).toHaveBeenCalledWith("acme.storemink.com");
  });

  it("passes a null host through when no host header is present", async () => {
    await POST(req());

    expect(sessionCookieOptions).toHaveBeenCalledWith(null);
  });

  it("never throws for a request carrying no cookie in the first place", async () => {
    // Signing out twice, or from a stale tab, must not 500.
    const res = await POST(req({ host: "acme.storemink.com" }));

    expect(res.status).toBe(200);
  });
});
