/**
 * The single source of truth for which storefront paths are kept out of search.
 *
 * This exists because robots.txt and sitemap.xml were contradicting each other:
 * `app/robots.ts` disallowed `/track-order` platform-wide, but that slug was
 * retired from RESERVED_PAGE_SLUGS in Phase 4b and is now ordinary merchant
 * `store_pages` data — linked from BOTH the default header and footer
 * (`lib/menus.ts`) and submitted in every store's sitemap. Telling a crawler
 * "index this" and "never fetch this" about the same URL wastes crawl budget and
 * makes the sitemap untrustworthy.
 *
 * So both sides now read this list, and `matchesDisallow` implements exactly the
 * matching robots.txt itself performs — otherwise the two would drift again the
 * first time someone added an entry.
 *
 * `exact: true` emits a `$` anchor. That matters for single-page routes: a plain
 * `Disallow: /cart` is a PREFIX match, so it would also block a merchant page
 * legitimately slugged `cartography`. Routes that own a subtree (`/checkout`,
 * `/blogs/write`) stay unanchored so their children are covered too.
 */
export interface DisallowRule {
  /** Path as it appears on a store host, no trailing slash. */
  readonly path: string;
  /** True when only this exact path is blocked, not its children. */
  readonly exact?: boolean;
}

/**
 * Storefront paths excluded from search. Auth-gated, personal, or transactional
 * — none of them are useful entry points from a search result.
 *
 * NOTE: robots.txt only stops CRAWLING. It does not deindex a URL that is
 * already indexed or linked from elsewhere, so any route that must never appear
 * in results also needs `robots: { index: false }` in its own metadata. The
 * checkout tree does both.
 */
export const STOREFRONT_DISALLOW: readonly DisallowRule[] = [
  { path: "/dashboard" },
  { path: "/pos" },
  { path: "/auth" },
  { path: "/api" },
  { path: "/cart", exact: true },
  { path: "/profile", exact: true },
  { path: "/checkout" },
  { path: "/orders" },
  { path: "/notifications" },
  { path: "/blogs/write", exact: true },
  { path: "/blogs/my-submissions", exact: true },
];

/**
 * The platform apex (storemink.com). It has no cart/profile/checkout, and
 * `/signup` is deliberately absent — it is a real landing page, listed in the
 * sitemap and linked from every CTA.
 */
export const PLATFORM_DISALLOW: readonly DisallowRule[] = [
  // ⚠ `/pos` is deliberately NOT here. On a store host it is the register and
  // is blocked above; on the apex it is the Point of Sale MARKETING page, one
  // of our most important entry points from search. Same path, opposite
  // intent — which is the whole reason these two lists are separate.
  { path: "/dashboard" },
  { path: "/auth" },
  { path: "/api" },
  { path: "/login", exact: true },
];

/** Render rules into the `disallow` strings robots.txt expects. */
export function disallowPaths(rules: readonly DisallowRule[]): string[] {
  return rules.map((r) => (r.exact ? `${r.path}$` : r.path));
}

/**
 * Does `path` fall under any rule? Mirrors robots.txt matching: an unanchored
 * rule covers the path itself and everything beneath it; an `exact` rule covers
 * only the path itself.
 *
 * Used to keep disallowed URLs OUT of the sitemap, so the two can't disagree.
 */
export function matchesDisallow(
  path: string,
  rules: readonly DisallowRule[] = STOREFRONT_DISALLOW,
): boolean {
  const p = path.startsWith("/") ? path : `/${path}`;
  return rules.some((r) =>
    r.exact ? p === r.path : p === r.path || p.startsWith(`${r.path}/`),
  );
}
