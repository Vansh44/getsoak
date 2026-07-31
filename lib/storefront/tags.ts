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
  billing: "storefront:billing",
  help: "help:centre",
} as const;
