/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session-cookie", () => ({
  SESSION_COOKIE: "sm_session",
  expiredHostOnlySessionCookieHeader: () =>
    "sm_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
  mintSessionCookie: vi.fn(),
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
import {
  mintSessionCookie,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie";

/** Minimal stand-in — the route only touches .headers.get() and .json(). */
function req(body: unknown, headers: Record<string, string> = {}): any {
  return {
    headers: new Headers(headers),
    json: async () => {
      if (body === "INVALID_JSON") throw new SyntaxError("Unexpected token");
      return body;
    },
  };
}

// The Phase 6 session bridge: the client posts its Firebase ID token here after
// any client-side sign-in, and we mint the ~14-day httpOnly cookie every request
// then reads via getServerUser() / the proxy.
describe("POST /api/auth/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mintSessionCookie).mockResolvedValue("MINTED_COOKIE");
  });

  it("rejects a body that is not valid JSON", async () => {
    const res = await POST(req("INVALID_JSON"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body." });
    expect(mintSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects a body with no idToken", async () => {
    const res = await POST(req({}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing idToken." });
    expect(mintSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects a non-string idToken", async () => {
    // A JSON body can carry any shape; passing an object straight to the Admin
    // SDK is how you get an unhandled throw instead of a 400.
    const res = await POST(req({ idToken: { evil: true } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing idToken." });
    expect(mintSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects an empty-string idToken", async () => {
    const res = await POST(req({ idToken: "" }));

    expect(res.status).toBe(400);
    expect(mintSessionCookie).not.toHaveBeenCalled();
  });

  it("answers 401 when the token does not verify", async () => {
    // mintSessionCookie returns null rather than throwing on a bad token, so
    // this is the ONLY thing standing between a forged token and a session.
    vi.mocked(mintSessionCookie).mockResolvedValue(null);

    const res = await POST(req({ idToken: "forged" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Could not create a session." });
    expect(res.cookies.get("sm_session")).toBeUndefined();
  });

  it("sets the session cookie on a verified token", async () => {
    const res = await POST(
      req({ idToken: "good" }, { host: "acme.storemink.com" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mintSessionCookie).toHaveBeenCalledWith("good");
    expect(res.cookies.get("sm_session")?.value).toBe("MINTED_COOKIE");
  });

  it("scopes the cookie using the request's own host", async () => {
    // The cookie spans .storemink.com so a signup on the platform host lands
    // signed-in on the store subdomain.
    await POST(req({ idToken: "good" }, { host: "acme.storemink.com" }));

    expect(sessionCookieOptions).toHaveBeenCalledWith("acme.storemink.com");
  });

  it("evicts a legacy host-only cookie when setting the shared-domain cookie", async () => {
    const res = await POST(req({ idToken: "good" }, { host: "storemink.com" }));

    const headers = res.headers.getSetCookie();
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain("Domain=.storemink.com");
    expect(headers[1]).toContain("Max-Age=0");
    expect(headers[1]).not.toContain("Domain=");
  });

  it("prefers the forwarded host behind the load balancer", async () => {
    await POST(
      req(
        { idToken: "good" },
        { "x-forwarded-host": "acme.storemink.com", host: "internal:8080" },
      ),
    );

    expect(sessionCookieOptions).toHaveBeenCalledWith("acme.storemink.com");
  });

  it("passes a null host through when no host header is present", async () => {
    await POST(req({ idToken: "good" }));

    expect(sessionCookieOptions).toHaveBeenCalledWith(null);
  });

  it("sets a host-only cookie on a merchant's custom domain", async () => {
    // §30: cookieDomainForHost returns undefined for a custom domain, so the
    // session does not leak across registrable domains.
    const res = await POST(req({ idToken: "good" }, { host: "acme.com" }));

    expect(res.cookies.get("sm_session")?.domain).toBeUndefined();
    expect(res.cookies.get("sm_session")?.value).toBe("MINTED_COOKIE");
    expect(res.headers.getSetCookie()).toHaveLength(1);
  });

  it("marks the cookie httpOnly so page scripts cannot read it", async () => {
    const res = await POST(
      req({ idToken: "good" }, { host: "acme.storemink.com" }),
    );

    expect(res.cookies.get("sm_session")?.httpOnly).toBe(true);
  });
});
