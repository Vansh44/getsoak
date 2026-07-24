// Pure JSON-LD builders for storefront structured data.
//
// No React and no I/O — every function takes plain data and returns a
// schema.org object, so they're trivially unit-testable (schema.test.ts) and
// reused across product / blog / page routes. Callers render the returned
// object(s) with the <JsonLd> component. Values that Google would reject as
// empty (blank description, zero-count rating, non-absolute images) are omitted
// rather than emitted null.

type Json = Record<string, unknown>;

// The storefront prices everything in INR (₹) — see lib/pricing.formatPrice.
const CURRENCY = "INR";

const IN_STOCK = "https://schema.org/InStock";
const OUT_OF_STOCK = "https://schema.org/OutOfStock";

function absolute(siteUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${siteUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Resolve an image reference to an absolute URL, or null if unusable. Uploaded
// media is already an absolute Supabase URL; theme-bundled imagery is a
// site-relative /public path — both must be absolute in structured data, so we
// prefix the store origin for the latter. Anything else (empty, protocol-less,
// data: URIs) is dropped.
function toAbsoluteImage(
  siteUrl: string,
  u: string | null | undefined,
): string | null {
  if (!u) return null;
  if (/^https?:\/\//.test(u)) return u;
  if (u.startsWith("/")) return `${siteUrl}${u}`;
  return null;
}

export interface ProductSchemaInput {
  siteUrl: string;
  brandName: string;
  name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  /** Any candidate image URLs; non-absolute or empty ones are dropped. */
  images?: (string | null | undefined)[];
  /** Effective selling price range. low === high ⇒ a single Offer. */
  price: { low: number; high: number };
  inStock: boolean;
  /** Only emitted when count > 0 — and only if reviews are shown on-page. */
  rating?: { value: number; count: number } | null;
}

// schema.org/Product with an Offer (or AggregateOffer for variant ranges) and,
// when the product has visible reviews, an AggregateRating — the markup that
// unlocks price / availability / star rich results for commerce.
export function productSchema(i: ProductSchemaInput): Json {
  const url = `${i.siteUrl}/shop/${i.slug}`;
  const images = [
    ...new Set(
      (i.images ?? [])
        .map((u) => toAbsoluteImage(i.siteUrl, u))
        .filter((u): u is string => !!u),
    ),
  ];
  const availability = i.inStock ? IN_STOCK : OUT_OF_STOCK;

  const offers: Json =
    i.price.low === i.price.high
      ? {
          "@type": "Offer",
          price: i.price.low,
          priceCurrency: CURRENCY,
          availability,
          url,
        }
      : {
          "@type": "AggregateOffer",
          lowPrice: i.price.low,
          highPrice: i.price.high,
          priceCurrency: CURRENCY,
          availability,
          url,
        };

  const schema: Json = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#product`,
    name: i.name,
    url,
    brand: { "@type": "Brand", name: i.brandName },
    offers,
  };
  if (i.description) schema.description = i.description;
  if (images.length) schema.image = images;
  if (i.category) schema.category = i.category;
  if (i.rating && i.rating.count > 0) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: Math.round(i.rating.value * 100) / 100,
      reviewCount: i.rating.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return schema;
}

export interface ArticleSchemaInput {
  siteUrl: string;
  brandName: string;
  logoUrl?: string | null;
  title: string;
  slug: string;
  description?: string | null;
  image?: string | null;
  authorName?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
}

// schema.org/BlogPosting for blog detail pages.
export function articleSchema(i: ArticleSchemaInput): Json {
  const url = `${i.siteUrl}/blogs/${i.slug}`;
  const logo = toAbsoluteImage(i.siteUrl, i.logoUrl);
  const image = toAbsoluteImage(i.siteUrl, i.image);
  const schema: Json = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: i.title,
    url,
    mainEntityOfPage: url,
    publisher: {
      "@type": "Organization",
      name: i.brandName,
      ...(logo ? { logo: { "@type": "ImageObject", url: logo } } : {}),
    },
  };
  if (i.description) schema.description = i.description;
  if (image) schema.image = [image];
  if (i.authorName) schema.author = { "@type": "Person", name: i.authorName };
  if (i.publishedAt) schema.datePublished = i.publishedAt;
  const modified = i.updatedAt ?? i.publishedAt;
  if (modified) schema.dateModified = modified;
  return schema;
}

export interface HelpArticleSchemaInput {
  /** The help-centre origin, e.g. https://help.storemink.com */
  siteUrl: string;
  /** Full canonical path of the article, e.g. /help/payments/enable-cod */
  path: string;
  title: string;
  description?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  /** Publisher org name + logo (StoreMink). */
  publisherName: string;
  logoUrl?: string | null;
}

// schema.org/TechArticle for help-centre docs — the type Google prefers for
// product/support documentation. Publisher is the platform org; no author
// (docs are first-party). Emitted only for the published/public view.
export function helpArticleSchema(i: HelpArticleSchemaInput): Json {
  const url = absolute(i.siteUrl, i.path);
  const logo = toAbsoluteImage(i.siteUrl, i.logoUrl);
  const schema: Json = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${url}#article`,
    headline: i.title,
    url,
    mainEntityOfPage: url,
    inLanguage: "en",
    publisher: {
      "@type": "Organization",
      name: i.publisherName,
      ...(logo ? { logo: { "@type": "ImageObject", url: logo } } : {}),
    },
  };
  if (i.description) schema.description = i.description;
  if (i.publishedAt) schema.datePublished = i.publishedAt;
  const modified = i.updatedAt ?? i.publishedAt;
  if (modified) schema.dateModified = modified;
  return schema;
}

// schema.org/BreadcrumbList — improves SERP breadcrumb display. Paths may be
// absolute or store-relative (resolved against siteUrl).
export function breadcrumbSchema(
  siteUrl: string,
  items: { name: string; path: string }[],
): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: it.name,
      item: absolute(siteUrl, it.path),
    })),
  };
}
