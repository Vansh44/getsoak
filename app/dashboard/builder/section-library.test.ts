import { describe, expect, it } from "vitest";
import { filterSectionTypes } from "./section-library";
import { HOMEPAGE_SECTION_TYPES } from "@/lib/homepage/section-types";

describe("filterSectionTypes", () => {
  it("returns every type for an empty query", () => {
    expect(filterSectionTypes("")).toEqual(HOMEPAGE_SECTION_TYPES);
    expect(filterSectionTypes("   ")).toEqual(HOMEPAGE_SECTION_TYPES);
  });

  it("matches by label, case-insensitively", () => {
    expect(filterSectionTypes("FAQ")).toContain("faq_accordion");
    expect(filterSectionTypes("hero")).toContain("hero");
    expect(filterSectionTypes("Testimonials")).toContain("testimonials");
  });

  it("matches by keyword", () => {
    expect(filterSectionTypes("javascript")).toEqual(["custom_code"]);
    expect(filterSectionTypes("bestsellers")).toEqual(["featured_products"]);
    expect(filterSectionTypes("lookbook")).toEqual(["gallery"]);
    expect(filterSectionTypes("social proof")).toEqual(["testimonials"]);
    expect(filterSectionTypes("vimeo")).toEqual(["video"]);
    expect(filterSectionTypes("mailing list")).toEqual(["newsletter"]);
  });

  it("matches by description", () => {
    expect(filterSectionTypes("sandbox")).toEqual(["custom_code"]);
  });

  it("returns nothing for a nonsense query", () => {
    expect(filterSectionTypes("zzzznope")).toEqual([]);
  });
});
