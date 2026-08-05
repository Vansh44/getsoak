import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check, Sparkles } from "lucide-react";
import { BrandMark } from "@/app/platform/brand-mark";
import { PLATFORM_URL, THEMES_URL } from "@/lib/site";
import { ROOT_DOMAIN } from "@/lib/store/host";
import {
  THEME_CATEGORIES,
  THEME_META,
  canPreviewTheme,
  isThemeSelectable,
  type ThemeIndustry,
  type ThemeMeta,
} from "@/lib/themes/meta";

const FEATURE_LABELS: Record<string, string> = {
  "advanced-search": "Advanced search",
  blogs: "Editorial blog",
  "cart-drawer": "Cart drawer",
  "category-navigation": "Category navigation",
  faq: "FAQ layouts",
  "product-filtering": "Product filtering",
  "product-recommendations": "Product recommendations",
  "promo-tiles": "Promotion tiles",
  "quick-add": "Quick add",
  "variant-picker": "Variant picker",
};

function demoUrl(slug: string) {
  return `https://${slug}.${ROOT_DOMAIN}`;
}

function statusLabel(theme: ThemeMeta) {
  if (theme.catalog.visibility === "legacy") return "Foundation theme";
  if (theme.release.status === "published") return "Available";
  if (theme.release.status === "approved") return "Approved";
  return "In review";
}

export default async function ThemesPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const requested = (await searchParams).industry;
  const selected: ThemeIndustry | "all" = THEME_CATEGORIES.some(
    (category) => category.id === requested,
  )
    ? (requested as ThemeIndustry | "all")
    : "all";
  const themes = THEME_META.filter(isThemeSelectable).filter(
    (theme) =>
      selected === "all" || theme.catalog.industries.includes(selected),
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "StoreMink Themes",
    url: THEMES_URL,
    description:
      "A curated catalog of responsive, commerce-ready StoreMink storefront themes.",
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: themes.length,
      itemListElement: themes.map((theme, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: theme.name,
        url: `${THEMES_URL}/#${theme.id}`,
      })),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <header className="themes-nav">
        <Link
          href={THEMES_URL}
          className="themes-wordmark"
          aria-label="StoreMink Themes home"
        >
          <BrandMark size={30} priority />
          <span>StoreMink</span>
          <em>Themes</em>
        </Link>
        <nav aria-label="Theme catalog navigation">
          <a href="#catalog">Browse themes</a>
          <a href="https://help.storemink.com">Help</a>
          <Link href={`${PLATFORM_URL}/signup`} className="themes-nav-cta">
            Start your store <ArrowUpRight size={15} />
          </Link>
        </nav>
      </header>

      <main>
        <section className="themes-hero">
          <p className="themes-kicker">
            <Sparkles size={15} aria-hidden /> Curated storefront design
          </p>
          <h1>
            Make your store
            <br />
            {" feel like "}
            <i>your brand.</i>
          </h1>
          <p className="themes-hero-copy">
            Distinctive starting points for serious commerce. Every StoreMink
            theme is responsive, deeply editable, and reviewed across the whole
            buying journey—not only the homepage.
          </p>
          <a href="#catalog" className="themes-hero-link">
            Explore the collection <ArrowRight size={18} />
          </a>
          <div className="themes-proof" aria-label="Theme quality promises">
            <span>
              <Check size={14} /> No-code editing
            </span>
            <span>
              <Check size={14} /> Mobile composed
            </span>
            <span>
              <Check size={14} /> Commerce tested
            </span>
          </div>
        </section>

        <section className="themes-catalog" id="catalog">
          <div className="themes-catalog-head">
            <div>
              <p className="themes-overline">The collection</p>
              <h2>Choose a point of view.</h2>
            </div>
            <p>
              New themes arrive only after they pass StoreMink&apos;s design,
              accessibility, performance, and commerce release gates.
            </p>
          </div>

          <nav
            className="themes-filters"
            aria-label="Filter themes by industry"
          >
            {THEME_CATEGORIES.map((category) => (
              <Link
                key={category.id}
                href={
                  category.id === "all"
                    ? "/"
                    : `/?industry=${category.id}#catalog`
                }
                aria-current={selected === category.id ? "page" : undefined}
              >
                {category.label}
              </Link>
            ))}
          </nav>

          <div className="themes-grid">
            {themes.map((theme, index) => {
              const previewable = canPreviewTheme(theme);
              return (
                <article className="theme-card" id={theme.id} key={theme.id}>
                  <div className="theme-card-visual">
                    <Image
                      src={theme.catalog.previewImage}
                      alt={`${theme.name} theme storefront preview`}
                      fill
                      sizes="(max-width: 760px) 100vw, 70vw"
                      priority={index === 0}
                    />
                    <span className="theme-card-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="theme-card-status">
                      {statusLabel(theme)}
                    </span>
                  </div>

                  <div className="theme-card-content">
                    <div className="theme-card-title">
                      <div>
                        <p>
                          {theme.catalog.industries
                            .join(" · ")
                            .replaceAll("-", " ")}
                        </p>
                        <h3>{theme.name}</h3>
                      </div>
                      <span>
                        {theme.catalog.minPlan
                          ? `${theme.catalog.minPlan}+`
                          : "All plans"}
                      </span>
                    </div>
                    <p className="theme-description">{theme.description}</p>
                    <ul
                      className="theme-features"
                      aria-label={`${theme.name} features`}
                    >
                      {theme.catalog.features.slice(0, 6).map((feature) => (
                        <li key={feature}>
                          {FEATURE_LABELS[feature] ?? feature}
                        </li>
                      ))}
                    </ul>
                    <div className="theme-card-actions">
                      {previewable ? (
                        <a
                          href={demoUrl(theme.demo.slug)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          View live store <ArrowUpRight size={15} />
                        </a>
                      ) : (
                        <span
                          className="theme-preview-offline"
                          title={theme.demo.unavailableReason}
                        >
                          Live preview being restored
                        </span>
                      )}
                      <Link href={`${PLATFORM_URL}/signup`}>
                        Start with {theme.name} <ArrowRight size={15} />
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="themes-standard">
          <p className="themes-overline">The StoreMink standard</p>
          <h2>A theme is more than a beautiful screenshot.</h2>
          <div>
            <p>
              We review product discovery, variants, cart states, content
              extremes, keyboard use, mobile composition, and real catalog data
              before a theme can be published.
            </p>
            <Link href={`${PLATFORM_URL}/signup`}>
              Build your store <ArrowUpRight size={16} />
            </Link>
          </div>
        </section>
      </main>

      <footer className="themes-footer">
        <div className="themes-wordmark">
          <BrandMark size={26} />
          <span>StoreMink</span>
          <em>Themes</em>
        </div>
        <p>Professional storefronts. No code required.</p>
        <nav aria-label="Footer navigation">
          <Link href={PLATFORM_URL}>StoreMink</Link>
          <a href="https://help.storemink.com">Help Centre</a>
          <Link href={`${PLATFORM_URL}/signup`}>Create a store</Link>
        </nav>
      </footer>
    </>
  );
}
