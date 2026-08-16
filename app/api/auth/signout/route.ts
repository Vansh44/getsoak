// Phase 6 — clear the Firebase session cookie. The client also calls the
// Firebase client SDK's signOut(); this route removes the httpOnly server
// cookie. The delete must carry the SAME domain/path attributes the cookie was
// set with, or the cross-subdomain (.storemink.com) cookie won't be removed.

import { type NextRequest, NextResponse } from "next/server";
import {
  expiredHostOnlySessionCookieHeader,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie";

export async function POST(request: NextRequest) {
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  const res = NextResponse.json({ ok: true });
  const options = sessionCookieOptions(host);
  res.cookies.set(SESSION_COOKIE, "", {
    ...options,
    maxAge: 0,
  });
  // Clear both possible tuples. Otherwise a legacy host-only cookie can make
  // "Sign out" appear to succeed while it remains the first cookie parsed on
  // the platform host.
  if (options.domain) {
    res.headers.append("Set-Cookie", expiredHostOnlySessionCookieHeader());
  }
  return res;
}
