import Image from "next/image";

// The StoreMink mark — the real one.
//
// ★ THE SOURCE OF TRUTH IS public/brand/storemink-mark.png — the owner's own
// artwork, 256×256 with a transparent background. NOT public/icon.svg: that
// held an older, duller render of the same design, and regenerating from it
// silently reverts the logo to the wrong colours (it has happened once).
//
// Everything else is derived from that one file and must be regenerated when it
// changes — storemink-mark.webp, app/icon.png, app/apple-icon.png,
// public/favicon.ico (16/32/48) and public/icon.svg. Don't hand-edit a
// derivative, or the nav and the favicon drift apart.
//
// `title` is optional on purpose: beside the visible "StoreMink" wordmark this
// is decorative and must not be announced twice.

export function BrandMark({
  size = 28,
  title,
  priority = false,
}: {
  size?: number;
  /** Only where the mark stands alone, with no adjacent wordmark. */
  title?: string;
  /** Set on the nav mark — it is above the fold on every page. */
  priority?: boolean;
}) {
  return (
    <Image
      src="/brand/storemink-mark.png"
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      width={size}
      height={size}
      priority={priority}
      style={{ display: "block", objectFit: "contain" }}
    />
  );
}
