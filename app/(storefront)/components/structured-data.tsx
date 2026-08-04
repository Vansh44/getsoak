import { getStoreBrand } from "@/lib/store/brand";
import { getStoreUrl } from "@/lib/site";

// Organization + WebSite JSON-LD for the current store's storefront homepage,
// resolved from that store's brand + canonical origin (not a hardcoded brand).
export default async function StructuredData() {
  const [brand, siteUrl] = await Promise.all([getStoreBrand(), getStoreUrl()]);
  const sameAs = [brand.social.instagram, brand.social.youtube].filter(
    (value): value is string => {
      if (!value) return false;
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
  );
  const description = brand.blurb ?? brand.tagline;
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: brand.name,
        ...(brand.legalName ? { legalName: brand.legalName } : {}),
        url: siteUrl,
        // Only claim a logo the merchant actually supplied. The old
        // `?? ${siteUrl}/icon.svg` fallback resolved to StoreMink's own icon —
        // and brand.logoUrl is null for EVERY new store (no theme seeds one), so
        // the default was to publish the platform's mark as the merchant's
        // official logo. Omitting the property is what lib/seo/schema.ts already
        // does; an absent logo is honest, a wrong one is a false entity claim.
        ...(brand.logoUrl ? { logo: brand.logoUrl } : {}),
        ...(description ? { description } : {}),
        ...(brand.email ? { email: brand.email } : {}),
        ...(brand.phone ? { telephone: brand.phone } : {}),
        ...(sameAs.length ? { sameAs } : {}),
        ...(brand.email || brand.phone
          ? {
              contactPoint: {
                "@type": "ContactPoint",
                contactType: "customer service",
                ...(brand.email ? { email: brand.email } : {}),
                ...(brand.phone ? { telephone: brand.phone } : {}),
              },
            }
          : {}),
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        name: brand.name,
        url: siteUrl,
        publisher: { "@id": `${siteUrl}/#organization` },
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}
