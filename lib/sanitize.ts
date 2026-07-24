import sanitizeHtml from "sanitize-html";

/**
 * Shared sanitization config for blog HTML content.
 *
 * Used on BOTH the write path (server actions persisting content) and the
 * render path (before dangerouslySetInnerHTML). Never trust stored HTML —
 * sanitize at the render boundary even if it was sanitized on write.
 */
const BLOG_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "img",
    "h1",
    "h2",
    "h3",
    "h4",
    "s",
    "u",
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ["src", "alt", "width", "height"],
    // Table cell spans (editor tables). colspan/rowspan aren't class/style/id/
    // data-*, so without these merged cells would collapse on sanitize.
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    "*": ["class", "style", "id", "data-*"],
  },
  // Whitelist specific CSS properties instead of allowing arbitrary inline
  // styles. Arbitrary `style` enables CSS-based exfiltration / clickjacking
  // even when scripts are stripped; these properties are what the editor
  // legitimately emits (text alignment, basic typography/colour).
  allowedStyles: {
    "*": {
      "text-align": [/^left$|^right$|^center$|^justify$/],
      "text-decoration": [/^[\w\s-]+$/],
      color: [
        /^#(0x)?[0-9a-f]+$/i,
        /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
      ],
      "background-color": [
        /^#(0x)?[0-9a-f]+$/i,
        /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
      ],
      // Editor table column widths (col/cell). Numeric px/% only.
      width: [/^\d+(\.\d+)?(px|%)$/],
      "min-width": [/^\d+(\.\d+)?(px|%)$/],
    },
  },
  // Only allow safe URL schemes for links/images.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
  },
};

/**
 * Sanitize blog HTML content. Returns an empty string for nullish input.
 */
export function sanitizeBlogContent(html: string | null | undefined): string {
  if (!html) return "";
  return sanitizeHtml(html, BLOG_SANITIZE_OPTIONS);
}
