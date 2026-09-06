// Cache tags for the storefront's `unstable_cache` reads (lib/storefront/queries.ts).
// Imported by the dashboard write actions so they can `revalidateTag(...)` the
// exact entries an edit affects. Kept dependency-free so importing it into a
// "use server" action doesn't pull in the Supabase client.
export const TAGS = {
  products: "storefront:products",
  categories: "storefront:categories",
  blogs: "storefront:blogs",
  blogTaxonomy: "storefront:blog-taxonomy",
  pages: "storefront:pages",
  /** Header + footer (store_chrome). Busted by publishChrome. */
  chrome: "storefront:chrome",
  /** @deprecated superseded by `chrome` — store_menus is no longer read. */
  menus: "storefront:menus",
  coupons: "storefront:coupons",
  /**
   * Offers, for the storefront's "Available coupons" list.
   *
   * ★ SEPARATE FROM `coupons`, though one read is tagged with both. A coupon
   * edit and an offer edit are different writes in different actions, and
   * making an offer save bust the coupon tag (or the reverse) would mean every
   * write in one feature quietly invalidating caches in the other.
   */
  offers: "storefront:offers",
  billing: "storefront:billing",
  help: "help:centre",
} as const;
