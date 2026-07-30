// Origins for the multi-tenant platform.
//
// PLATFORM_URL is the Storemink platform's own origin (the apex) — used as the
// default/fallback and as the base for the email-worker's internal self-call.
// getStoreUrl() returns the CURRENT request's store canonical origin — use it
// for per-store SEO/canonical.
import { ROOT_DOMAIN } from "@/lib/store/host";
import { getCurrentStore, type Store } from "@/lib/store/resolve";

// Defined in lib/store/host.ts (pure, no DB imports) and re-exported here so
// this stays the one place most code looks for platform origins.
export { PLATFORM_URL } from "@/lib/store/host";

// Canonical origin of the help centre (help.{root}). Used for help-article
// canonicals, OG urls, JSON-LD and the help branch of sitemap.ts/robots.ts.
export const HELP_URL = `https://help.${ROOT_DOMAIN}`;

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
  store: Pick<Store, "slug" | "custom_domain" | "settings">,
): string {
  const verified = store.settings?.custom_domain_verified === true;
  const host =
    verified && store.custom_domain
      ? store.custom_domain
      : `${store.slug}.${ROOT_DOMAIN}`;
  return `https://${host}`;
}

// Canonical origin of the current request's store.
export async function getStoreUrl(): Promise<string> {
  return storeOrigin(await getCurrentStore());
}
