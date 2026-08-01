import { describe, it, expect } from "vitest";
import {
  PLATFORM_DISALLOW,
  STOREFRONT_DISALLOW,
  disallowPaths,
  matchesDisallow,
} from "./disallow";

describe("disallowPaths", () => {
  it("anchors exact rules with $ and leaves subtree rules unanchored", () => {
    const out = disallowPaths([
      { path: "/cart", exact: true },
      { path: "/checkout" },
    ]);
    expect(out).toEqual(["/cart$", "/checkout"]);
  });
});

describe("matchesDisallow", () => {
  it("blocks a subtree rule and everything beneath it", () => {
    expect(matchesDisallow("/checkout")).toBe(true);
    expect(matchesDisallow("/checkout/success")).toBe(true);
    expect(matchesDisallow("/checkout/invoice/abc-123")).toBe(true);
  });

  it("blocks an exact rule only at that exact path", () => {
    expect(matchesDisallow("/cart")).toBe(true);
    expect(matchesDisallow("/profile")).toBe(true);
  });

  // The whole reason `exact` exists: robots.txt matching is prefix-based, so a
  // bare `Disallow: /cart` would also block a merchant page slugged
  // "cartography". Anchoring keeps merchant slugs that merely share a prefix
  // both crawlable and submitted.
  it("does not block a merchant slug that merely shares a prefix", () => {
    expect(matchesDisallow("/cartography")).toBe(false);
    expect(matchesDisallow("/profiles-of-our-growers")).toBe(false);
    expect(matchesDisallow("/orders-explained")).toBe(false);
  });

  // Phase 4b retired track-order from RESERVED_PAGE_SLUGS; it is merchant
  // store_pages data, linked from the default header AND footer (lib/menus.ts)
  // and submitted in the sitemap. robots.txt used to block it anyway.
  it("allows /track-order, which is merchant page data", () => {
    expect(matchesDisallow("/track-order")).toBe(false);
  });

  it("normalises a slug passed without a leading slash", () => {
    expect(matchesDisallow("cart")).toBe(true);
    expect(matchesDisallow("about-us")).toBe(false);
  });

  it("accepts an explicit rule set", () => {
    expect(matchesDisallow("/login", PLATFORM_DISALLOW)).toBe(true);
    expect(matchesDisallow("/login", STOREFRONT_DISALLOW)).toBe(false);
  });
});
