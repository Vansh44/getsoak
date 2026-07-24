import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { HELP_URL, PLATFORM_URL } from "@/lib/site";
import { ROOT_DOMAIN, SEARCH_INDEXABLE, isHelpHost } from "@/lib/store/host";
import {
  getPublishedProducts,
  getPublishedBlogCards,
  getPublishedPageSlugs,
} from "@/lib/storefront/queries";
import {
  getHelpCategories,
  getPublishedHelpArticleParams,
} from "@/lib/help/queries";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";

// Regenerate hourly; the underlying product/blog reads are themselves cached
// and invalidated on dashboard edits.
export const revalidate = 3600;

type ChangeFreq = MetadataRoute.Sitemap[number]["changeFrequency"];

// Only the routes that exist for EVERY store live in code (the interactive
// route groups that were never migrated to store_pages). Everything else —
// our-story, faqs, contact, gift-packs, … — is now per-store data in
// store_pages and comes from getPublishedPageSlugs below, so this sitemap is
// correct for any tenant, not just WholeSip. (Storefront routes live in the
// parenthesised (storefront)/(pages) groups, which add no URL segment, e.g.
// /shop not /pages/shop.) Auth-gated / utility routes — cart, profile, order
// tracking, blog authoring, my-submissions — are intentionally omitted.
const STATIC_PATHS: { path: string; priority: number; freq: ChangeFreq }[] = [
  { path: "/", priority: 1, freq: "daily" },
  { path: "/shop", priority: 0.9, freq: "daily" },
  { path: "/blogs", priority: 0.7, freq: "weekly" },
  { path: "/enquiries", priority: 0.4, freq: "monthly" },
];

// Image sitemaps need an absolute image URL. Uploaded media is already an
// absolute URL (GCS, or legacy Supabase Storage); theme-bundled imagery is a
// site-relative /public path, so resolve that against the store origin.
// Anything else is skipped.
function imageEntry(
  siteUrl: string,
  url: string | null | undefined,
): { images?: string[] } {
  if (!url) return {};
  if (/^https?:\/\//.test(url)) return { images: [url] };
  if (url.startsWith("/")) return { images: [`${siteUrl}${url}`] };
  return {};
}

// The platform apex (storemink.com) has no store catalog — its sitemap is its
// own public marketing pages. Kept separate from the per-store sitemap so the
// WholeSip fallback never leaks its products into storemink.com/sitemap.xml.
const PLATFORM_PATHS: { path: string; priority: number; freq: ChangeFreq }[] = [
  { path: "/", priority: 1, freq: "weekly" },
  { path: "/signup", priority: 0.8, freq: "monthly" },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Only production (storemink.com) is crawlable; staging / previews / dev emit
  // an empty sitemap (see robots.ts + SEARCH_INDEXABLE in lib/store/host.ts).
  if (!SEARCH_INDEXABLE) return [];

  const now = new Date();

  // Help centre (help.storemink.com): its own sitemap of the docs. It has no
  // store, so branch before the store/platform resolution below.
  const host =
    (await headers()).get("x-forwarded-host") || (await headers()).get("host");
  if (isHelpHost(host)) {
    const [categories, articles] = await Promise.all([
      getHelpCategories().catch(() => []),
      getPublishedHelpArticleParams().catch(() => []),
    ]);
    const entries: MetadataRoute.Sitemap = [
      {
        url: `${HELP_URL}/help`,
        lastModified: now,
        changeFrequency: "weekly",
        priority: 1,
      },
      ...categories.map((c) => ({
        url: `${HELP_URL}/help/${c.slug}`,
        lastModified: now,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      })),
      ...articles.map((a) => ({
        url: `${HELP_URL}/help/${a.categorySlug}/${a.slug}`,
        lastModified: a.updatedAt ? new Date(a.updatedAt) : now,
        changeFrequency: "monthly" as const,
        priority: 0.8,
      })),
    ];
    return entries;
  }

  // Per-host: resolve the store on the requesting domain. No real store (the
  // platform apex, or an unresolved host) → emit the platform's own sitemap
  // instead of falling back to the WholeSip catalog.
  const store = await getCurrentStoreOrNull();
  if (!store) {
    return PLATFORM_PATHS.map((p) => ({
      url: `${PLATFORM_URL}${p.path === "/" ? "" : p.path}`,
      lastModified: now,
      changeFrequency: p.freq,
      priority: p.priority,
    }));
  }

  const siteUrl = `https://${store.custom_domain ?? `${store.slug}.${ROOT_DOMAIN}`}`;
  const storeId = store.id;

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((p) => ({
    url: `${siteUrl}${p.path === "/" ? "" : p.path}`,
    lastModified: now,
    changeFrequency: p.freq,
    priority: p.priority,
  }));

  // Dynamic product + blog detail pages, plus merchant-built custom pages, for
  // THIS store. A failed DB read must never break the sitemap, so each falls
  // back to empty.
  const [products, blogs, customPages] = await Promise.all([
    getPublishedProducts(storeId).catch(() => []),
    getPublishedBlogCards(storeId).catch(() => []),
    getPublishedPageSlugs(storeId).catch(() => []),
  ]);

  const productEntries: MetadataRoute.Sitemap = (
    products as { slug: string; image_url: string | null }[]
  )
    .filter((p) => p.slug)
    .map((p) => ({
      url: `${siteUrl}/shop/${p.slug}`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
      ...imageEntry(siteUrl, p.image_url),
    }));

  const blogEntries: MetadataRoute.Sitemap = (
    blogs as {
      slug: string;
      published_at: string | null;
      cover_image_url: string | null;
    }[]
  )
    .filter((b) => b.slug)
    .map((b) => ({
      url: `${siteUrl}/blogs/${b.slug}`,
      lastModified: b.published_at ? new Date(b.published_at) : now,
      changeFrequency: "monthly",
      priority: 0.6,
      ...imageEntry(siteUrl, b.cover_image_url),
    }));

  const pageEntries: MetadataRoute.Sitemap = customPages
    .filter((p) => p.slug)
    .map((p) => ({
      url: `${siteUrl}/${p.slug}`,
      lastModified: p.updated_at ? new Date(p.updated_at) : now,
      changeFrequency: "monthly",
      priority: 0.6,
    }));

  return [...staticEntries, ...productEntries, ...blogEntries, ...pageEntries];
}
