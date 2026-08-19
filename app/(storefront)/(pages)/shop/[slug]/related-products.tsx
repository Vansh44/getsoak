import {
  ShopCard,
  type ShopCardProduct,
} from "@/app/(storefront)/components/shop-card";
import { HorizontalCarousel } from "@/app/(storefront)/components/homepage/horizontal-carousel";
import "@/app/(storefront)/components/homepage/homepage.css";

export interface RelatedProduct {
  id: string;
  name: string;
  slug: string;
  base_price: number;
  selling_price: number;
  image_url: string | null;
  images: string[] | null;
  card_color: string | null;
  featured: boolean;
  /** Resolved category name (flattened in the page query). */
  category: string | null;
  variants: {
    base_price: number;
    selling_price: number;
    special_price: number | null;
    sort_order: number;
  }[];
}

// "You may also like" — renders the shared ShopCard so it stays visually in
// sync with the shop grid (category eyebrow, quick-add, and any theme card
// treatment like the grocery skin all come for free).
export function RelatedProducts({
  products,
  grocery = false,
  storeLowStockThreshold = 0,
}: {
  products: RelatedProduct[];
  grocery?: boolean;
  storeLowStockThreshold?: number;
}) {
  if (!products || products.length === 0) return null;

  return (
    <section className="pdp-related">
      <h2 className="pdp-related-title">
        {grocery ? "You might also like" : "You may also like"}
      </h2>
      <HorizontalCarousel
        carouselClass="home-product-carousel"
        scrollClass="home-product-scroll"
        arrowClass="home-product-arrow"
      >
        {products.map((p) => (
          <ShopCard
            key={p.id}
            product={p as unknown as ShopCardProduct}
            storeLowStockThreshold={storeLowStockThreshold}
          />
        ))}
      </HorizontalCarousel>
    </section>
  );
}
