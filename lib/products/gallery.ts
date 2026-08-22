// ---------------------------------------------------------------------------
// Product gallery composition — the ONE answer to "which photographs does this
// product have, and in what order".
//
// `products.image_url` is the primary photograph and `products.images` is the
// rest of the gallery, but the two overlap inconsistently: the column defaults
// to `['']` (a one-element array holding an empty string, NOT an empty array),
// the dashboard editor writes additional images only, and `applyTheme` seeds
// presets whose `images` repeats the primary as its first entry. So a caller
// must filter falsy entries AND de-duplicate, or it renders a broken <img> for
// a store that has never touched its gallery and shows the same photograph
// twice for one seeded from a theme.
//
// This lived inline in the product-detail client. The card now needs the same
// answer for its hover image, and two hand-written copies of a de-duplication
// rule is how a card ends up cross-fading a product to itself.
// ---------------------------------------------------------------------------

/**
 * Every distinct, non-empty photograph for a product, primary first.
 * Order is meaningful: [0] is the card/PDP hero, [1] is the hover image.
 */
export function productGallery(
  imageUrl: string | null | undefined,
  images: readonly (string | null)[] | null | undefined,
): string[] {
  const all = [imageUrl, ...(images ?? [])].filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0,
  );
  return Array.from(new Set(all));
}

/**
 * The photograph a product card cross-fades to on hover, or null when the
 * product has only one. Null is the common case — most products carry a single
 * image — and the card must render no second layer at all for those, so the
 * browser is never asked to fetch something that cannot be shown.
 */
export function hoverImageUrl(
  imageUrl: string | null | undefined,
  images: readonly (string | null)[] | null | undefined,
): string | null {
  return productGallery(imageUrl, images)[1] ?? null;
}
