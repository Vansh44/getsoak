import Image from "next/image";

// The StoreMink mark — the real one.
//
// The source of truth is public/icon.svg, but that file is a 2048×2098 PNG
// base64'd inside an <svg> wrapper: 3.1 MB, fine as a favicon, impossible to
// put in a nav. public/brand/storemink-mark.* are the web-usable derivatives —
// trimmed of their transparent margin (so the mark fills its box at 26px) and
// resized: 25 KB PNG, 38 KB WebP, both transparent.
//
// REGENERATE THEM FROM icon.svg if the logo ever changes — decode the embedded
// PNG, `sharp(...).trim().resize(...)`. Don't hand-edit the derivatives, or
// they and the favicon will drift apart.
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
