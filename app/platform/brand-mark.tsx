import Image from "next/image";
import { STOREMINK_LOGO } from "@/lib/brand-assets";

// Master: brand/assets/storemink-master.png (owner artwork, September 2026).
// Regenerate every derivative with scripts/build-brand-assets.mjs. Display
// exports remove the transparent margins; favicons have a tighter crop.
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
      src={STOREMINK_LOGO}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      width={size}
      height={size}
      preload={priority}
      style={{ display: "block", objectFit: "contain", flexShrink: 0 }}
    />
  );
}
