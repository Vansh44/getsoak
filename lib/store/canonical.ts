import "server-only";

// ---------------------------------------------------------------------------
// "Is this store supposed to be served on a different host?"
//
// Used by proxy.ts to send `{slug}.storemink.com` to a merchant's verified custom
// domain, so a store has ONE address rather than two that both work.
//
// ★ THE DECISION IS storeOrigin(), NOT A SECOND COPY OF THE RULES. Whether a
// custom domain counts depends on two gates — proven ownership
// (`custom_domain_verified`) and current entitlement (`effectivePlan`) — and
// `storeOrigin` is already the one place that applies them, shared with
// canonical URLs, sitemaps, robots and og:url. Re-deriving them here would mean
// a store could be redirected to a host that canonical metadata disowns, or a
// lapsed Pro plan could keep redirecting to a domain `lookupStoreByHost` has
// stopped serving. Only the FETCH is local; the judgement is borrowed.
//
// ★ WHY A HAND-ROLLED CACHE. `lookupStoreByHost` is wrapped in `unstable_cache`,
// which needs a render scope and is unavailable in proxy middleware. Rather than
// pay a database round-trip on every storefront request — the one path this
// codebase deliberately keeps free of per-request work — the mapping is held in
// process for a short TTL. Being briefly stale is harmless: the worst case is a
// newly-verified domain not being redirected to for up to a minute.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { storeOrigin } from "@/lib/site";
import { logError } from "@/lib/observability/logger";

/** Short enough that a domain going live or lapsing takes effect promptly. */
const TTL_MS = 60_000;

/**
 * Bounded, so a flood of requests for nonexistent slugs cannot grow it without
 * limit. Small: this only ever holds one entry per active store per instance.
 */
const MAX_ENTRIES = 1000;

interface Entry {
  /** Canonical host for the slug, or null when it is the subdomain itself. */
  host: string | null;
  at: number;
}

const cache = new Map<string, Entry>();

function readCache(slug: string, nowMs: number): Entry | undefined {
  const hit = cache.get(slug);
  if (!hit) return undefined;
  if (nowMs - hit.at >= TTL_MS) {
    cache.delete(slug);
    return undefined;
  }
  return hit;
}

function writeCache(slug: string, host: string | null, nowMs: number): void {
  if (cache.size >= MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(slug, { host, at: nowMs });
}

/** Test seam — the cache is module state and would leak between cases. */
export function __clearCanonicalCache(): void {
  cache.clear();
}

/**
 * The host this store should be served on, or null to stay on the subdomain.
 *
 * ★ FAILS OPEN. A database error returns null, meaning "no redirect" — the
 * subdomain keeps working. The alternative (throwing, or guessing a host) would
 * turn a transient DB blip into every store on the platform redirecting somewhere
 * wrong, or into a 500 on the storefront. There is no failure mode here worth
 * breaking a working page for.
 */
export async function canonicalHostForSlug(
  slug: string,
  nowMs = Date.now(),
): Promise<string | null> {
  const key = slug.toLowerCase();
  const hit = readCache(key, nowMs);
  if (hit) return hit.host;

  try {
    const rows = await withAnon((db) =>
      db
        .select({
          slug: stores.slug,
          custom_domain: stores.customDomain,
          settings: stores.settings,
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
        })
        .from(stores)
        .where(and(eq(stores.slug, key), eq(stores.status, "active")))
        .limit(1),
    );
    const store = rows[0];
    if (!store) {
      // Cached too: an unknown slug is a cheap, repeatable answer, and caching it
      // stops a scan for random subdomains hammering the database.
      writeCache(key, null, nowMs);
      return null;
    }

    const origin = storeOrigin(store as Parameters<typeof storeOrigin>[0]);
    const host = new URL(origin).host.toLowerCase();
    // Only a DIFFERENT host is worth reporting; storeOrigin returns the
    // subdomain itself whenever the custom domain fails either gate.
    const canonical = host === `${key}.${rootHost()}` ? null : host;
    writeCache(key, canonical, nowMs);
    return canonical;
  } catch (err) {
    logError("canonicalHostForSlug", err, { slug: key });
    return null;
  }
}

function rootHost(): string {
  return (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com").toLowerCase();
}
