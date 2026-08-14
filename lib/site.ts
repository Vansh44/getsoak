// Origins for the multi-tenant platform.
//
// PLATFORM_URL is the Storemink platform's own origin (the apex) — used as the
// default/fallback and as the base for the email-worker's internal self-call.
// getStoreUrl() returns the CURRENT request's store canonical origin — use it
// for per-store SEO/canonical.
import { ROOT_DOMAIN } from "@/lib/store/host";
import {
  getCurrentStore,
  lookupStoreById,
  type Store,
} from "@/lib/store/resolve";
import { PLAN_LIMITS, effectivePlan } from "@/lib/plans";

// Defined in lib/store/host.ts (pure, no DB imports) and re-exported here so
// this stays the one place most code looks for platform origins.
export { PLATFORM_URL } from "@/lib/store/host";

// Canonical origin of the help centre (help.{root}). Used for help-article
// canonicals, OG urls, JSON-LD and the help branch of sitemap.ts/robots.ts.
export const HELP_URL = `https://help.${ROOT_DOMAIN}`;

// Canonical origin of the public theme discovery catalog.
export const THEMES_URL = `https://themes.${ROOT_DOMAIN}`;

// Canonical origin of the public Point of Sale product site. This is distinct
// from each merchant's actual register at `{slug}.{root}/pos`.
export const POS_URL = `https://pos.${ROOT_DOMAIN}`;

/**
 * The store's PUBLIC canonical origin — its custom domain **only once that
 * domain is proven-owned**, otherwise its {slug}.{ROOT_DOMAIN} subdomain.
 *
 * The `custom_domain_verified` check is not optional politeness: it is the same
 * rule `lookupStoreByHost` (lib/store/resolve.ts) applies when deciding whether
 * to *serve* on a custom domain, and the two must agree. They didn't. A store
 * that had merely TYPED a domain was still served on its subdomain, but every
 * canonical, og:url, robots `Host:` and sitemap `<loc>` pointed at the unverified
 * domain — so Google followed a canonical to a host that doesn't resolve and
 * dropped the working subdomain URLs as "Alternate page with proper canonical
 * tag". That is silent, total deindexing of a whole tenant, and it is reachable
 * by design: saveCustomDomain (app/actions/store-domain.ts) writes
 * `custom_domain` while clearing `custom_domain_verified`, so EVERY merchant
 * passes through this state between typing a domain and finishing DNS.
 *
 * Pure, so both the request-scoped getStoreUrl() and the host-resolved
 * robots.ts / sitemap.ts can share exactly one definition.
 */
export function storeOrigin(
  store: Pick<
    Store,
    "slug" | "custom_domain" | "settings" | "plan" | "plan_expires_at"
  >,
): string {
  const verified = store.settings?.custom_domain_verified === true;
  // Serving and canonical selection must share the entitlement gate. An
  // expired timed plan is no longer allowed on its custom domain in
  // lookupStoreByHost(); continuing to publish that dead host in canonical,
  // robots and sitemap metadata would deindex the still-working subdomain.
  const entitled = PLAN_LIMITS[effectivePlan(store)].customDomain;
  const host =
    verified && entitled && store.custom_domain
      ? store.custom_domain
      : `${store.slug}.${ROOT_DOMAIN}`;
  return `https://${host}`;
}

// Canonical origin of the current request's store.
export async function getStoreUrl(): Promise<string> {
  return storeOrigin(await getCurrentStore());
}

/** Canonical origin for a known store id. Server actions that can run from the
 * platform operator host must use this instead of deriving tenancy from the
 * request Host header. */
export async function getStoreOriginById(
  storeId: string,
): Promise<string | null> {
  const store = await lookupStoreById(storeId);
  return store ? storeOrigin(store) : null;
}
