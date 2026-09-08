/** Versioned URLs refresh browser, image-optimizer and social-card caches. */
const BRAND_ASSET_ROOT = "/brand/20260908";

export const STOREMINK_LOGO = `${BRAND_ASSET_ROOT}/storemink-mark.png`;
export const STOREMINK_MARK = `${BRAND_ASSET_ROOT}/storemink-mark.webp`;

/** Platform chrome and merchant fallback only; never override a store's logo. */
export const STOREMINK_ICONS = {
  apple: [
    {
      url: `${BRAND_ASSET_ROOT}/apple-touch-icon.png`,
      sizes: "180x180",
      type: "image/png",
    },
  ],
  icon: [16, 32, 48].map((size) => ({
    url: `${BRAND_ASSET_ROOT}/favicon-${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
  })),
};
