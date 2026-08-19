import { describe, it, expect } from "vitest";
import { productGallery, hoverImageUrl } from "./gallery";

describe("productGallery", () => {
  it("puts the primary first and keeps gallery order", () => {
    expect(productGallery("/a.webp", ["/b.webp", "/c.webp"])).toEqual([
      "/a.webp",
      "/b.webp",
      "/c.webp",
    ]);
  });

  it("drops the column's [''] default rather than emitting an empty src", () => {
    // products.images is `text[] NOT NULL DEFAULT ['']`, so an untouched
    // product arrives as [""] — not [].
    expect(productGallery("/a.webp", [""])).toEqual(["/a.webp"]);
    expect(hoverImageUrl("/a.webp", [""])).toBeNull();
  });

  it("de-duplicates a primary repeated inside images (theme seeds do this)", () => {
    expect(productGallery("/a.webp", ["/a.webp", "/b.webp"])).toEqual([
      "/a.webp",
      "/b.webp",
    ]);
    expect(hoverImageUrl("/a.webp", ["/a.webp", "/b.webp"])).toBe("/b.webp");
  });

  it("treats whitespace-only and null entries as absent", () => {
    expect(productGallery("/a.webp", ["   ", null, "/b.webp"])).toEqual([
      "/a.webp",
      "/b.webp",
    ]);
  });

  it("survives a missing primary and a missing array", () => {
    expect(productGallery(null, ["/b.webp"])).toEqual(["/b.webp"]);
    expect(productGallery("/a.webp", null)).toEqual(["/a.webp"]);
    expect(productGallery(null, null)).toEqual([]);
    expect(productGallery(undefined, undefined)).toEqual([]);
  });
});

describe("hoverImageUrl", () => {
  it("is the second distinct photograph", () => {
    expect(hoverImageUrl("/a.webp", ["/b.webp", "/c.webp"])).toBe("/b.webp");
  });

  it("is null when the product has only one photograph", () => {
    expect(hoverImageUrl("/a.webp", [])).toBeNull();
    expect(hoverImageUrl("/a.webp", ["/a.webp"])).toBeNull();
    expect(hoverImageUrl(null, null)).toBeNull();
  });

  it("promotes a gallery image when there is no primary", () => {
    // A product with no image_url still gets a hover pair from its gallery.
    expect(hoverImageUrl(null, ["/b.webp", "/c.webp"])).toBe("/c.webp");
  });
});
