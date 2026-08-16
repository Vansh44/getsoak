// Phase 6 — Firebase session-cookie exchange. After any client-side sign-in
// (email/password, Google, phone), the client posts its Firebase ID token here;
// we verify it and mint a ~14-day httpOnly session cookie scoped to
// .storemink.com (spans platform + every store subdomain), which every request
// then reads via getServerUser() / the proxy. Runs on the Node runtime
// (firebase-admin). DORMANT until Identity Platform is configured.

import { type NextRequest, NextResponse } from "next/server";
import {
  expiredHostOnlySessionCookieHeader,
  SESSION_COOKIE,
  mintSessionCookie,
  sessionCookieOptions,
} from "@/lib/auth/session-cookie";

export async function POST(request: NextRequest) {
  let idToken: string | undefined;
  try {
    const body = (await request.json()) as { idToken?: unknown };
    idToken = typeof body.idToken === "string" ? body.idToken : undefined;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }
  if (!idToken) {
    return NextResponse.json({ error: "Missing idToken." }, { status: 400 });
  }

  const cookie = await mintSessionCookie(idToken);
  if (!cookie) {
    return NextResponse.json(
      { error: "Could not create a session." },
      { status: 401 },
    );
  }

  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  const res = NextResponse.json({ ok: true });
  const options = sessionCookieOptions(host);
  res.cookies.set(SESSION_COOKIE, cookie, options);
  // Before sessions were shared across subdomains, `storemink.com` could leave
  // a host-only sm_session behind. It can shadow this fresh Domain cookie
  // forever because Set-Cookie only replaces an exact name/domain/path tuple.
  // ResponseCookies de-duplicates by name, so append the second tuple raw.
  if (options.domain) {
    res.headers.append("Set-Cookie", expiredHostOnlySessionCookieHeader());
  }
  return res;
}
