import { getStoreBrand } from "@/lib/store/brand";
import { getStoreUrl } from "@/lib/site";

// Organization + WebSite JSON-LD for the current store's storefront homepage,
// resolved from that store's brand + canonical origin (not a hardcoded brand).
export default async function StructuredData() {
  const [brand, siteUrl] = await Promise.all([getStoreBrand(), getStoreUrl()]);
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: brand.name,
        url: siteUrl,
        // Only claim a logo the merchant actually supplied. The old
        // `?? ${siteUrl}/icon.svg` fallback resolved to StoreMink's own icon —
        // and brand.logoUrl is null for EVERY new store (no theme seeds one), so
        // the default was to publish the platform's mark as the merchant's
        // official logo. Omitting the property is what lib/seo/schema.ts already
        // does; an absent logo is honest, a wrong one is a false entity claim.
        ...(brand.logoUrl ? { logo: brand.logoUrl } : {}),
        ...(brand.tagline ? { description: brand.tagline } : {}),
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
