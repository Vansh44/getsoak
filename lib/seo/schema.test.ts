/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import {
  productSchema,
  articleSchema,
  breadcrumbSchema,
  helpArticleSchema,
} from "./schema";

const SITE = "https://acme.storemink.com";

describe("productSchema", () => {
  const base = {
    siteUrl: SITE,
    brandName: "Acme",
    name: "Cold Brew",
    slug: "cold-brew",
    inStock: true,
    price: { low: 199, high: 199 },
  };

  it("emits a single Offer when low === high", () => {
    const s = productSchema(base) as Record<string, any>;
    expect(s["@type"]).toBe("Product");
    expect(s.url).toBe(`${SITE}/shop/cold-brew`);
    expect(s.offers["@type"]).toBe("Offer");
    expect(s.offers.price).toBe(199);
    expect(s.offers.priceCurrency).toBe("INR");
    expect(s.offers.availability).toBe("https://schema.org/InStock");
    expect(s.brand).toEqual({ "@type": "Brand", name: "Acme" });
  });

  it("emits an AggregateOffer for a price range", () => {
    const s = productSchema({
      ...base,
      price: { low: 199, high: 349 },
    }) as Record<string, any>;
    expect(s.offers["@type"]).toBe("AggregateOffer");
    expect(s.offers.lowPrice).toBe(199);
    expect(s.offers.highPrice).toBe(349);
  });

  it("marks out-of-stock products", () => {
    const s = productSchema({ ...base, inStock: false }) as Record<string, any>;
    expect(s.offers.availability).toBe("https://schema.org/OutOfStock");
  });

  it("includes aggregateRating only when there are reviews", () => {
    const without = productSchema(base) as Record<string, any>;
    expect(without.aggregateRating).toBeUndefined();

    const withRating = productSchema({
      ...base,
      rating: { value: 4.6666, count: 3 },
    }) as Record<string, any>;
    expect(withRating.aggregateRating.reviewCount).toBe(3);
    expect(withRating.aggregateRating.ratingValue).toBe(4.67); // rounded
  });

  it("keeps absolute images, resolves site-relative ones, drops the rest", () => {
    const s = productSchema({
      ...base,
      images: [
        null,
        "",
        "data:image/png;base64,xx",
        "/t.jpg",
        "https://cdn.test/a.jpg",
      ],
    }) as Record<string, any>;
    // /t.jpg → absolute against siteUrl; data: URI and empties dropped.
    expect(s.image).toEqual([`${SITE}/t.jpg`, "https://cdn.test/a.jpg"]);
  });

  it("dedupes repeated image URLs", () => {
    const s = productSchema({
      ...base,
      images: ["/t.jpg", "/t.jpg", "https://cdn.test/a.jpg"],
    }) as Record<string, any>;
    expect(s.image).toEqual([`${SITE}/t.jpg`, "https://cdn.test/a.jpg"]);
  });

  it("omits image entirely when none are valid", () => {
    const s = productSchema({ ...base, images: [null, ""] }) as Record<
      string,
      any
    >;
    expect(s.image).toBeUndefined();
  });
});

describe("articleSchema", () => {
  it("builds a BlogPosting with publisher + dates", () => {
    const s = articleSchema({
      siteUrl: SITE,
      brandName: "Acme",
      logoUrl: "https://cdn.test/logo.png",
      title: "Why cold brew",
      slug: "why-cold-brew",
      description: "A deep dive",
      image: "https://cdn.test/cover.jpg",
      authorName: "Jane",
      publishedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    }) as Record<string, any>;
    expect(s["@type"]).toBe("BlogPosting");
    expect(s.headline).toBe("Why cold brew");
    expect(s.url).toBe(`${SITE}/blogs/why-cold-brew`);
    expect(s.author).toEqual({ "@type": "Person", name: "Jane" });
    expect(s.datePublished).toBe("2026-01-01T00:00:00Z");
    expect(s.dateModified).toBe("2026-02-01T00:00:00Z");
    expect(s.publisher.logo.url).toBe("https://cdn.test/logo.png");
  });

  it("falls back dateModified to publishedAt and omits absent fields", () => {
    const s = articleSchema({
      siteUrl: SITE,
      brandName: "Acme",
      title: "T",
      slug: "t",
      publishedAt: "2026-01-01T00:00:00Z",
    }) as Record<string, any>;
    expect(s.dateModified).toBe("2026-01-01T00:00:00Z");
    expect(s.author).toBeUndefined();
    expect(s.image).toBeUndefined();
    expect(s.publisher.logo).toBeUndefined();
  });
});

describe("breadcrumbSchema", () => {
  it("numbers items and resolves relative paths", () => {
    const s = breadcrumbSchema(SITE, [
      { name: "Home", path: "/" },
      { name: "Shop", path: "/shop" },
      { name: "Cold Brew", path: "/shop/cold-brew" },
    ]) as Record<string, any>;
    expect(s["@type"]).toBe("BreadcrumbList");
    expect(s.itemListElement).toHaveLength(3);
    expect(s.itemListElement[0]).toMatchObject({
      position: 1,
      name: "Home",
      item: `${SITE}/`,
    });
    expect(s.itemListElement[2].item).toBe(`${SITE}/shop/cold-brew`);
  });

  it("passes absolute paths through unchanged", () => {
    const s = breadcrumbSchema(SITE, [
      { name: "X", path: "https://other.test/x" },
    ]) as Record<string, any>;
    expect(s.itemListElement[0].item).toBe("https://other.test/x");
  });
});

describe("helpArticleSchema", () => {
  const HELP = "https://help.storemink.com";
  const base = {
    siteUrl: HELP,
    path: "/help/payments/enable-cod",
    title: "Enable Cash on Delivery",
    publisherName: "StoreMink",
  };

  it("emits a TechArticle with an absolute url and @id", () => {
    const s = helpArticleSchema(base) as Record<string, any>;
    expect(s["@type"]).toBe("TechArticle");
    expect(s.url).toBe(`${HELP}/help/payments/enable-cod`);
    expect(s["@id"]).toBe(`${HELP}/help/payments/enable-cod#article`);
    expect(s.headline).toBe("Enable Cash on Delivery");
    expect(s.publisher).toMatchObject({
      "@type": "Organization",
      name: "StoreMink",
    });
  });

  it("omits empty description and dates, resolves the logo", () => {
    const s = helpArticleSchema(base) as Record<string, any>;
    expect(s.description).toBeUndefined();
    expect(s.datePublished).toBeUndefined();
    expect(s.publisher.logo).toBeUndefined();

    const full = helpArticleSchema({
      ...base,
      description: "Turn on COD for your store.",
      publishedAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-10T00:00:00Z",
      logoUrl: "/icon.svg",
    }) as Record<string, any>;
    expect(full.description).toBe("Turn on COD for your store.");
    expect(full.datePublished).toBe("2026-07-01T00:00:00Z");
    expect(full.dateModified).toBe("2026-07-10T00:00:00Z");
    expect(full.publisher.logo).toEqual({
      "@type": "ImageObject",
      url: `${HELP}/icon.svg`,
    });
  });

  it("falls back dateModified to publishedAt when no updatedAt", () => {
    const s = helpArticleSchema({
      ...base,
      publishedAt: "2026-07-01T00:00:00Z",
    }) as Record<string, any>;
    expect(s.dateModified).toBe("2026-07-01T00:00:00Z");
  });
});
