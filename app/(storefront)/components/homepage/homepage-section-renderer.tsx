import type { ShopCardProduct } from "../shop-card";
import { FeaturedProductsSection } from "./featured-products-section";
import {
  ShopByCategorySection,
  type CategoryTile,
} from "./shop-by-category-section";
import { PromoBannerSection } from "./promo-banner-section";
import { LatestBlogsSection, type BlogCardData } from "./latest-blogs-section";
import { RichTextSection } from "../sections/rich-text-section";
import { CustomCodeSection } from "../sections/custom-code-section";
import { HeroSection } from "../sections/hero-section";
import { HeroCarouselSection } from "../sections/hero-carousel-section";
import { UspBarSection } from "../sections/usp-bar-section";
import { TickerSection } from "../sections/ticker-section";
import { TileGridSection } from "../sections/tile-grid-section";
import { MediaTextSection } from "../sections/media-text-section";
import { GallerySection } from "../sections/gallery-section";
import { TestimonialsSection } from "../sections/testimonials-section";
import { VideoSection } from "../sections/video-section";
import { NewsletterSection } from "../sections/newsletter-section";
import { FaqAccordionSection } from "../sections/faq-accordion-section";
import type {
  AnySectionConfig,
  CustomCodeConfig,
  FaqAccordionConfig,
  FeaturedProductsConfig,
  GalleryConfig,
  HeroCarouselConfig,
  HeroConfig,
  HomepageSectionType,
  LatestBlogsConfig,
  MediaTextConfig,
  NewsletterSectionConfig,
  PromoBannerConfig,
  RichTextConfig,
  SectionStyle,
  ShopByCategoryConfig,
  TickerConfig,
  TileGridConfig,
  TestimonialsConfig,
  VideoConfig,
  UspBarConfig,
} from "@/lib/homepage/section-types";

// The minimal shape the renderer needs — satisfied by both homepage_sections
// rows (HomepageSection) and store_pages section items (PageSectionItem).
export interface RenderableSection {
  id: string;
  type: HomepageSectionType;
  config: AnySectionConfig;
  /** Shared appearance applied by SectionShell (absent on pre-style rows). */
  style?: SectionStyle;
}

// Resolved data the renderer needs, keyed by section id. Built once per page
// via lib/sections/resolve-data.ts from batched queries (no per-section
// fetching).
export interface ResolvedData {
  productsBySection: Map<string, ShopCardProduct[]>;
  categoriesBySection: Map<string, CategoryTile[]>;
  blogsBySection: Map<string, BlogCardData[]>;
  // Store-wide default low-stock threshold (inventory.lowStockThreshold) so the
  // featured-products cards render the same "Only X left" badge as the shop grid.
  storeLowStockThreshold: number;
}

export function HomepageSectionRenderer({
  section,
  resolved,
}: {
  section: RenderableSection;
  resolved: ResolvedData;
}) {
  const shell = { sectionId: section.id, style: section.style };
  switch (section.type) {
    case "hero":
      return <HeroSection {...shell} config={section.config as HeroConfig} />;
    case "hero_carousel":
      return (
        <HeroCarouselSection
          {...shell}
          config={section.config as HeroCarouselConfig}
        />
      );
    case "usp_bar":
      return (
        <UspBarSection {...shell} config={section.config as UspBarConfig} />
      );
    case "ticker":
      return (
        <TickerSection {...shell} config={section.config as TickerConfig} />
      );
    case "tile_grid":
      return (
        <TileGridSection {...shell} config={section.config as TileGridConfig} />
      );
    case "media_text":
      return (
        <MediaTextSection
          {...shell}
          config={section.config as MediaTextConfig}
        />
      );
    case "gallery":
      return (
        <GallerySection {...shell} config={section.config as GalleryConfig} />
      );
    case "testimonials":
      return (
        <TestimonialsSection
          {...shell}
          config={section.config as TestimonialsConfig}
        />
      );
    case "video":
      return <VideoSection {...shell} config={section.config as VideoConfig} />;
    case "newsletter":
      return (
        <NewsletterSection
          {...shell}
          config={section.config as NewsletterSectionConfig}
        />
      );
    case "faq_accordion":
      return (
        <FaqAccordionSection
          {...shell}
          config={section.config as FaqAccordionConfig}
        />
      );
    case "featured_products":
      return (
        <FeaturedProductsSection
          {...shell}
          config={section.config as FeaturedProductsConfig}
          products={resolved.productsBySection.get(section.id) ?? []}
          storeLowStockThreshold={resolved.storeLowStockThreshold}
        />
      );
    case "shop_by_category":
      return (
        <ShopByCategorySection
          {...shell}
          config={section.config as ShopByCategoryConfig}
          categories={resolved.categoriesBySection.get(section.id) ?? []}
        />
      );
    case "promo_banner":
      return (
        <PromoBannerSection
          {...shell}
          config={section.config as PromoBannerConfig}
        />
      );
    case "latest_blogs":
      return (
        <LatestBlogsSection
          {...shell}
          config={section.config as LatestBlogsConfig}
          blogs={resolved.blogsBySection.get(section.id) ?? []}
        />
      );
    case "rich_text":
      return (
        <RichTextSection {...shell} config={section.config as RichTextConfig} />
      );
    case "custom_code":
      return (
        <CustomCodeSection
          {...shell}
          config={section.config as CustomCodeConfig}
        />
      );
    default:
      return null;
  }
}
