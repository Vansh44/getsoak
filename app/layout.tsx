import "./globals.css";
import {
  Outfit,
  Roboto,
  Stick_No_Bills,
  Inter,
  Fraunces,
  Space_Grotesk,
  Plus_Jakarta_Sans,
  Jost,
  Instrument_Serif,
} from "next/font/google";
import NextTopLoader from "nextjs-toploader";
import { PLATFORM_URL } from "@/lib/site";
import { BRAND_DESCRIPTION } from "@/lib/seo/brand-identity";
import { SEARCH_INDEXABLE } from "@/lib/store/host";

// Default WholeSip / platform fonts.
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });
const roboto = Roboto({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-roboto",
});
const stickNoBills = Stick_No_Bills({
  weight: ["800"],
  subsets: ["latin"],
  variable: "--font-stick-no-bills",
});

// ── Theme font palette ──────────────────────────────────────────────────
// next/font runs at build time, so every family a theme CAN pick must be
// declared here. A theme's design.fonts references these --font-* variables;
// the (storefront) layout re-points --font-outfit / --font-stick-no-bills to
// the chosen families, re-skinning all storefront typography with no CSS
// find-replace. Weights kept tight to bound the download.
//
// preload: false — which of these a page actually uses is decided per request
// from the store's theme, so we must NOT emit <link rel=preload> for all of
// them on every page (that forced 4 extra font downloads on every render,
// including stores on the default look that use NONE of them — an LCP/CLS
// cost). They still load on demand for a store whose theme references them,
// with display:swap (next/font's default) + auto size-adjusted fallbacks
// keeping any flash minimal. The base families below (the default look) stay
// preloaded.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  preload: false,
});
const fraunces = Fraunces({
  subsets: ["latin"],
  // Italic is a real face here, not a synthesized slant: the root 404's display
  // accent is set in Fraunces italic, and faux-obliquing a serif at 70px looks
  // broken. Still preload:false — only pages that render italic Fraunces text
  // fetch the extra file.
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  preload: false,
});
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  preload: false,
});
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  preload: false,
});
// Jost is a geometric (Futura-lineage) sans and carries a whole storefront on
// its own — Vitrine sets body AND most headings in it, leaning on the 300/400/
// 500 range rather than on a second family. Weights are listed explicitly
// because the light end does the display work.
const jost = Jost({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-jost",
  preload: false,
});
// Display only: a single high-contrast serif weight used for listing headlines
// against Jost's geometry. One face, one weight — it is an accent, not a
// text family.
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-instrument-serif",
  preload: false,
});

// Neutral platform-level fallback. The (storefront) layout overrides this per
// store (brand name + canonical origin); the (platform) layout sets its own.
export const metadata = {
  metadataBase: new URL(PLATFORM_URL),
  applicationName: "StoreMink",
  title: { default: "StoreMink", template: "%s" },
  description: BRAND_DESCRIPTION,
  // Belt-and-braces with the X-Robots-Tag header in next.config.ts: on any
  // non-production build EVERY page inherits noindex, including store
  // subdomains on staging. Production evaluates this to nothing, so nothing is
  // added there. (app/help/layout.tsx already did this for the help host only.)
  ...(SEARCH_INDEXABLE ? {} : { robots: { index: false, follow: false } }),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${roboto.variable} ${stickNoBills.variable} ${inter.variable} ${fraunces.variable} ${spaceGrotesk.variable} ${jakarta.variable} ${jost.variable} ${instrumentSerif.variable}`}
    >
      <body className="antialiased">
        <NextTopLoader color="#1a1a1a" showSpinner={false} />
        {children}
      </body>
    </html>
  );
}
