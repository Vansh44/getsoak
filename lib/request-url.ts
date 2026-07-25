import "server-only";

import { headers } from "next/headers";

// The origin of the CURRENT request (scheme + host), e.g.
//   http://echos.localhost:3000        (local dev)
//   https://echos.staging.storemink.com (staging)
//   https://echos.storemink.com         (production)
//
// Use this for links a human must actually CLICK — invitations, magic links,
// verification emails. It differs from lib/site.ts `getStoreUrl()`, which
// returns the store's CANONICAL https origin (derived from ROOT_DOMAIN) and is
// the right choice for SEO canonicals/OG urls but is unreachable in local dev
// (it points at whatever NEXT_PUBLIC_ROOT_DOMAIN says, e.g. staging).
//
// Kept in its own module rather than lib/site.ts: that file is imported by
// static routes (robots.ts / sitemap.ts), and pulling `next/headers` into their
// graph risks forcing them dynamic.
// Returns null (never throws) when there is no request scope — a cron job, a
// background worker, or a unit test — so callers can simply fall back to a
// configured origin.
export async function getRequestOrigin(): Promise<string | null> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return null;
  }
  const host = h.get("x-forwarded-host") || h.get("host");
  if (!host) return null;
  // Behind a proxy the scheme comes from the header; locally there is none, and
  // localhost is served over http.
  const proto =
    h.get("x-forwarded-proto") ??
    (/(^|\.)localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/.test(host)
      ? "http"
      : "https");
  return `${proto}://${host}`;
}
