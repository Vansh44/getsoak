import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import {
  PLATFORM_DISALLOW,
  STOREFRONT_DISALLOW,
  disallowPaths,
} from "@/lib/seo/disallow";
import { HELP_URL, PLATFORM_URL, THEMES_URL, storeOrigin } from "@/lib/site";
import {
  SEARCH_INDEXABLE,
  isHelpHost,
  isPlatformHost,
  isThemesHost,
} from "@/lib/store/host";
import { isStoreLaunched } from "@/lib/store/launch";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";

export default async function robots(): Promise<MetadataRoute.Robots> {
  // Only the real production platform (storemink.com) is crawlable. Staging,
  // previews, and local dev keep the WHOLE site out of search engines (see
  // SEARCH_INDEXABLE in lib/store/host.ts — derived from the apex domain, so
  // there's no per-deploy flag to forget). NEXT_PUBLIC_NOINDEX=1 forces it off.
  if (!SEARCH_INDEXABLE) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  // Help centre (help.storemink.com) — crawl the docs, advertise its own
  // canonical host + sitemap. It has no store, so it must branch before the
  // store/platform fallback below.
  const host =
    (await headers()).get("x-forwarded-host") || (await headers()).get("host");
  if (isHelpHost(host)) {
    return {
      rules: { userAgent: "*", allow: "/" },
      sitemap: `${HELP_URL}/sitemap.xml`,
      host: HELP_URL,
    };
  }

  if (isThemesHost(host)) {
    return {
      rules: { userAgent: "*", allow: "/" },
      sitemap: `${THEMES_URL}/sitemap.xml`,
      host: THEMES_URL,
    };
  }

  // Host-aware: a real store host advertises its own canonical origin (custom
  // domain only once VERIFIED — see storeOrigin), and the platform apex
  // advertises the platform itself.
  const store = await getCurrentStoreOrNull();

  // A store-SHAPED host that resolves to no store — an unclaimed subdomain, a
  // suspended store, a demo that was never seeded. Falling through to the
  // platform branch made every one of them answer `Allow: /` while advertising
  // storemink.com's Host + Sitemap, inviting crawlers to a host that serves
  // nothing of its own. Nothing here is indexable, so say so.
  if (!store && !isPlatformHost(host)) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  // A store that has never published anything of its own is still the theme's
  // seed content — the same pages every other store on that theme has. Keep it
  // out until the merchant makes it theirs (lib/store/launch.ts). Demo stores
  // are permanent showcases of exactly that shared content, so they stay out
  // for good.
  if (store && (!isStoreLaunched(store) || store.settings?.demo === true)) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  const siteUrl = store ? storeOrigin(store) : PLATFORM_URL;
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Admin app, auth flows, API, and personal/transactional pages. Shared
      // with app/sitemap.ts via lib/seo/disallow.ts so a URL can never be
      // blocked here and submitted there — `/track-order` was, for months.
      disallow: disallowPaths(store ? STOREFRONT_DISALLOW : PLATFORM_DISALLOW),
    },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
