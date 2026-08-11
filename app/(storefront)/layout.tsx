import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Header from "@/app/(storefront)/components/header/Header";
import Footer from "@/app/(storefront)/components/footer/Footer";
import AuthProvider from "@/app/(storefront)/components/auth/AuthProvider";
import CartProvider from "@/app/(storefront)/components/cart/CartProvider";
import CartDrawer from "@/app/(storefront)/components/cart/CartDrawer";
import AuthModalLoader from "@/app/(storefront)/components/auth/auth-modal-loader";
import { BrandProvider } from "@/app/(storefront)/components/brand-provider";
import { ChromeProvider } from "@/app/(storefront)/components/chrome-provider";
import { notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getStoreBrand } from "@/lib/store/brand";
import { getStoreChrome, getDraftChromeForPreview } from "@/lib/chrome/queries";
import { resolveStorefrontAppearance } from "@/lib/chrome/types";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { getStoreUrl } from "@/lib/site";
import { getThemeDefinition } from "@/lib/themes";
import { readThemeSelection } from "@/lib/themes/meta";
import { designToCssVars } from "@/lib/themes/types";
import { Toaster } from "@/components/ui/sonner";
import { GOOGLE_VERIFICATION_TOKEN_KEY } from "@/lib/seo/store-indexing";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import "./storefront-theme.css";

// Per-store default title/template + canonical origin. Individual pages may set
// their own title; this is the fallback and the "%s | Brand" suffix, and
// metadataBase makes OG/canonical URLs resolve to this store's own domain.
export async function generateMetadata(): Promise<Metadata> {
  // Guard like the layout component does: on an unclaimed/suspended host the
  // layout renders the root "store doesn't exist" 404. generateMetadata runs
  // independently, so it must NOT fall back to the WholeSip brand here (that's
  // what getStoreBrand()/getStoreUrl() do) — otherwise the tab title becomes
  // "… | WholeSip" and the favicon becomes WholeSip's logo on the 404.
  const store = await getCurrentStoreOrNull();
  if (!store) {
    return {
      title: "Store not found",
      icons: { icon: "/brand/storemink-mark.png" },
      robots: { index: false, follow: false },
    };
  }

  const [brand, siteUrl] = await Promise.all([getStoreBrand(), getStoreUrl()]);
  const googleVerification = store.settings?.[GOOGLE_VERIFICATION_TOKEN_KEY];
  return {
    metadataBase: new URL(siteUrl),
    title: { default: brand.name, template: `%s | ${brand.name}` },
    description: brand.tagline ?? undefined,
    icons: brand.logoUrl
      ? { icon: brand.logoUrl }
      : { icon: "/brand/storemink-mark.png" },
    ...(typeof googleVerification === "string" && googleVerification
      ? { verification: { google: googleVerification } }
      : {}),
  };
}

export default async function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // An unclaimed subdomain / unknown custom domain must NOT fall back to the
  // WholeSip storefront — render a proper "store not found" 404 instead. This
  // one guard covers every storefront page (they all render inside this layout).
  const store = await getCurrentStoreOrNull();
  if (!store) notFound();

  // Anonymous storefronts do not need Firebase's browser SDK on their initial
  // route. A server cookie means identity must be restored immediately; with
  // no cookie the provider starts Firebase only if the account UI is opened.
  const hasCustomerSession = (await cookies()).has(SESSION_COOKIE);

  // Chrome: the PUBLISHED header/footer, except inside the builder's preview
  // iframe where the admin is shown their unsaved draft.
  //
  // The ?preview=1 flag arrives as a header because a LAYOUT cannot read
  // searchParams (Next 16) and this layout is what renders Header/Footer — see
  // the note in proxy.ts. The header is only a hint: getDraftChromeForPreview
  // runs the same getManagerUserId("builder") gate as the page-draft loader and
  // returns null for everyone else, so forging it leaks nothing.
  const previewing = (await headers()).get("x-sm-preview") === "1";
  const [brand, publishedChrome, draftChrome] = await Promise.all([
    getStoreBrand(),
    getStoreChrome(store.id),
    previewing ? getDraftChromeForPreview(store.id) : Promise.resolve(null),
  ]);
  const chrome = draftChrome ?? publishedChrome;

  // The visual skin: resolve the store's pinned theme release (falling back to
  // the legacy settings.template id) and flatten
  // its palette/fonts/shape into CSS custom properties written inline on
  // .storefront-root. Inline-style specificity beats the globals.css :root
  // defaults, so the whole storefront re-skins with no per-component wiring.
  // A store with NO real theme id (the WholeSip fallback, legacy stores) gets
  // only --brand-primary — the globals.css defaults ARE the WholeSip look, so
  // it stays exactly as today.
  const themeSelection = readThemeSelection(store.settings);
  const design = themeSelection
    ? getThemeDefinition(themeSelection.id, themeSelection.version).preset
        .design
    : null;
  const themeVars: Record<string, string> = design
    ? designToCssVars(design, brand.primaryColor)
    : { "--brand-primary": brand.primaryColor };

  // Theme defaults + the merchant's published builder overrides resolve into
  // one appearance. Root classes let CSS switch treatments without forking
  // components; the same resolver runs client-side for instant builder preview.
  const appearance = resolveStorefrontAppearance(
    design?.layout,
    chrome.appearance,
  );
  const rootClass = [
    "storefront-root",
    `sm-header-${appearance.header}`,
    `sm-card-${appearance.card}`,
    appearance.cardQuickAdd ? "sm-card-quickadd" : "",
    `sm-pdp-${appearance.productDetail}`,
    `sm-cart-${appearance.cart}`,
    `sm-footer-${appearance.footer}`,
    appearance.card === "grocery" ||
    appearance.productDetail === "grocery" ||
    appearance.cart === "grocery"
      ? "sm-storefront-grocery"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <AuthProvider initialHasSession={hasCustomerSession}>
      <CartProvider>
        <BrandProvider brand={brand}>
          <ChromeProvider
            chrome={chrome}
            themeLayout={design?.layout}
            live={previewing}
          >
            <div className={rootClass} style={themeVars as CSSProperties}>
              <Header />
              {children}
              <Footer />
            </div>
          </ChromeProvider>
        </BrandProvider>
        <AuthModalLoader />
        <CartDrawer />
        <Toaster richColors />
      </CartProvider>
    </AuthProvider>
  );
}
