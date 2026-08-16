// Firebase session-cookie helpers (GCP migration Phase 6). The session model
// that replaces Supabase's SSR cookies:
//
//   sign-in (client) → Firebase ID token → POST /api/auth/session
//     → mintSessionCookie() verifies the ID token + mints a ~14-day session
//       cookie, set httpOnly/Secure/Domain=.storemink.com (spans platform +
//       every store subdomain, exactly like the old Supabase cookie).
//   every request → verifySessionCookie() decodes it (uid, email, phone, and
//     the role / force_password_reset custom claims) with NO network call after
//     warmup, so it's cheap enough for the Node-runtime proxy.
//
// DORMANT until Identity Platform is configured: when the Admin SDK isn't set
// up, mint/verify return null and callers keep using the live Supabase path.

import { cookieDomainForHost } from "@/lib/store/host";
import { getFirebaseAdminAuth } from "./firebase-admin";
import { SESSION_COOKIE } from "./constants";

/** Cross-subdomain session cookie name (distinct from Supabase's sb-* cookies
 *  so both can coexist during the migration). */
export { SESSION_COOKIE };

// Firebase session cookies max out at 14 days.
const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;

/** The two custom claims we carry (role + force_password_reset; mirror of the
 *  Firebase custom claims set in lib/auth/firebase-claims.ts). */
export interface SessionClaims {
  role: string | null;
  forcePasswordReset: boolean;
}

/** Decoded identity from a verified session cookie. */
export interface SessionUser {
  uid: string;
  email: string | null;
  /** True when Firebase has verified control of the email address. */
  emailConfirmed: boolean;
  phone: string | null;
  /** Firebase phone numbers are verified when present. */
  phoneConfirmed: boolean;
  name: string | null;
  claims: SessionClaims;
}

/**
 * Verify a Firebase ID token (from the client after sign-in) and mint a session
 * cookie. Returns null when Identity Platform isn't configured or the token is
 * invalid — the caller (`POST /api/auth/session`) then 401s.
 */
export async function mintSessionCookie(
  idToken: string,
): Promise<string | null> {
  const auth = getFirebaseAdminAuth();
  if (!auth) return null;
  try {
    // Verify the ID token first so we never mint a cookie from a forged token.
    await auth.verifyIdToken(idToken);
    return await auth.createSessionCookie(idToken, {
      expiresIn: SESSION_MAX_AGE_MS,
    });
  } catch (err) {
    console.error("mintSessionCookie:", err);
    return null;
  }
}

/**
 * Verify a session cookie and return the decoded identity + claims, or null
 * when it's missing/invalid/expired (or Identity Platform isn't configured).
 * Local signature check against cached Google certs — no per-request network
 * call after warmup, so it's safe in the proxy.
 */
export async function verifySessionCookie(
  cookie: string | undefined,
): Promise<SessionUser | null> {
  if (!cookie) return null;
  const auth = getFirebaseAdminAuth();
  if (!auth) return null;
  try {
    const decoded = await auth.verifySessionCookie(cookie);
    const role =
      typeof decoded.role === "string"
        ? decoded.role
        : typeof decoded.user_role === "string"
          ? (decoded.user_role as string)
          : null;
    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      emailConfirmed: decoded.email_verified === true,
      phone: (decoded.phone_number as string | undefined) ?? null,
      phoneConfirmed: Boolean(decoded.phone_number),
      name: (decoded.name as string | undefined) ?? null,
      claims: {
        role,
        forcePasswordReset: decoded.force_password_reset === true,
      },
    };
  } catch {
    // Expired / revoked / malformed — treat as signed-out.
    return null;
  }
}

/** httpOnly cookie options scoped to share across platform + store subdomains,
 *  mirroring the old Supabase `.storemink.com` cookie behaviour. */
export function sessionCookieOptions(host: string | null | undefined): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  domain?: string;
} {
  const domain = cookieDomainForHost(host);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    ...(domain ? { domain } : {}),
  };
}

/**
 * Expire a legacy host-only session cookie without touching the current
 * `.storemink.com` cookie.  A host-only cookie and a Domain cookie may share
 * the same name; browsers then send both and `cookies().get()` returns only
 * the first.  NextResponse.cookies cannot emit both variants because it
 * de-duplicates by name, so session/sign-out Route Handlers append this
 * explicit second Set-Cookie header after setting the Domain cookie.
 */
export function expiredHostOnlySessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}
