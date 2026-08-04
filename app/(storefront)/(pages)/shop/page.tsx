import type { Metadata } from "next";
import {
  getPublishedProducts,
  getActiveCategories,
} from "@/lib/storefront/queries";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getStorefrontLayout } from "@/lib/store/storefront-layout";
import { getStoreSetting } from "@/lib/settings/resolve";
import { getStoreBrand } from "@/lib/store/brand";
import ShopClient, { type ShopProduct, type ShopCategory } from "./shop-client";
import "./shop.css";

// Per-store metadata — the layout templates the title as "%s | {brand}", so
// this returns just "Shop" and a brand-aware description (never WholeSip).
//
// ?category= and ?q= are client-side facets over the same catalog, not
// distinct pages, so every variant canonicalises to /shop to consolidate link
// equity. Internal search-result pages (?q=) are additionally noindex'd —
// Google discourages indexing site-search results.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}): Promise<Metadata> {
  const [brand, { q }] = await Promise.all([getStoreBrand(), searchParams]);
  const description = `Browse the full ${brand.name} range.`;
  return {
    title: "Shop",
    description,
    alternates: { canonical: "/shop" },
    robots: q ? { index: false, follow: true } : undefined,
    openGraph: {
      title: `Shop | ${brand.name}`,
      description,
      url: "/shop",
      type: "website",
    },
  };
}

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const { category: initialCategorySlug, q: initialQuery } = await searchParams;
  const storeId = await requireStorefrontStoreId();

  const [products, categories, layout, lowStockThreshold] = await Promise.all([
    getPublishedProducts(storeId),
    getActiveCategories(storeId),
    getStorefrontLayout(),
    getStoreSetting("inventory.lowStockThreshold"),
  ]);

  const shopProducts = products as unknown as ShopProduct[];
  const shopCategories = categories as unknown as ShopCategory[];

  return (
    <ShopClient
      products={shopProducts}
      categories={shopCategories}
      initialCategorySlug={initialCategorySlug}
      initialQuery={initialQuery}
      grocery={layout.card === "grocery"}
      storeLowStockThreshold={lowStockThreshold as number}
    />
  );
}
