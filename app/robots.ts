import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { HELP_URL, PLATFORM_URL } from "@/lib/site";
import { ROOT_DOMAIN, SEARCH_INDEXABLE, isHelpHost } from "@/lib/store/host";
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

  // Host-aware: a real store host advertises its own canonical origin; the
  // platform apex (storemink.com) and any unresolved host must advertise the
  // platform itself — NOT the WholeSip fallback that getStoreUrl() would return
  // here (that pointed robots/sitemap at wholesip.com on storemink.com).
  const store = await getCurrentStoreOrNull();
  const siteUrl = store
    ? `https://${store.custom_domain ?? `${store.slug}.${ROOT_DOMAIN}`}`
    : PLATFORM_URL;
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Keep the admin app, auth flows, API, and personal/utility pages out of
      // the index.
      disallow: [
        "/dashboard",
        "/auth",
        "/api",
        "/cart",
        "/profile",
        "/track-order",
        "/blogs/write",
        "/blogs/my-submissions",
      ],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
