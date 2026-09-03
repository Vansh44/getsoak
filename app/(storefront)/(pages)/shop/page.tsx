import type { Metadata } from "next";
import {
  getPublishedProducts,
  getActiveCategories,
} from "@/lib/storefront/queries";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getStorefrontLayout } from "@/lib/store/storefront-layout";
import { getStoreSetting } from "@/lib/settings/resolve";
import { getStoreBrand } from "@/lib/store/brand";
import { loadOffersForStorefront } from "@/lib/offers/cart";
import { offerBadgeFor } from "@/lib/offers/badge";
import { effectivePricing } from "@/lib/pricing";
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

  const [
    products,
    categories,
    layout,
    lowStockThreshold,
    showBadges,
    offerBundle,
  ] = await Promise.all([
    getPublishedProducts(storeId),
    getActiveCategories(storeId),
    getStorefrontLayout(),
    getStoreSetting("inventory.lowStockThreshold"),
    getStoreSetting("offers.showBadges"),
    // Joins the same concurrent batch rather than adding a serial read, and
    // fails open to no offers on its own — a shop that cannot show a badge
    // still sells.
    loadOffersForStorefront(storeId, null, []),
  ]);

  const shopProducts = products as unknown as ShopProduct[];
  const shopCategories = categories as unknown as ShopCategory[];

  // Resolved HERE, per product, through the engine itself — so a badge is
  // literally what the cart would give and cannot overstate a saving. See
  // lib/offers/badge.ts for the three ordinary cases a naive "the offer says
  // 20%" badge gets wrong.
  const offerBadges: Record<string, { label: string }> = {};
  if (showBadges !== false) {
    for (const p of shopProducts) {
      const priced = effectivePricing(p);
      const badge = offerBadgeFor(
        {
          productId: p.id,
          categoryId:
            (p as { category_id?: string | null }).category_id ?? null,
          unitPrice: priced.selling,
          // ★★ THE PRICE IT IS ON SALE FROM, NOT THE MRP. This passed
          // `priced.base`, the struck-through list price — so every product
          // with an MRP set read as on sale, and under the default `best` mode
          // the offer was measured against that MRP and scored nothing. The
          // badge was therefore absent on most of a catalogue and present only
          // on products with no MRP. `regularSelling` is the variant's own
          // pre-special price, which is what `placeOrder` passes.
          regularUnitPrice: priced.regularSelling,
        },
        offerBundle.offers,
        offerBundle.policy,
      );
      if (badge) offerBadges[p.id] = { label: badge.label };
    }
  }

  return (
    <ShopClient
      products={shopProducts}
      categories={shopCategories}
      initialCategorySlug={initialCategorySlug}
      initialQuery={initialQuery}
      grocery={layout.card === "grocery"}
      storeLowStockThreshold={lowStockThreshold as number}
      offerBadges={offerBadges}
    />
  );
}
