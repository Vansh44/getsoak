import { describe, expect, it } from "vitest";
import {
  MINK_DRAFT_CONFIG,
  estimateMinkDraftIntent,
  normalizeMinkDraftContent,
} from "./draft-types";

describe("Mink draft contracts", () => {
  it("keeps the documented weighted-credit schedule stable", () => {
    expect(
      Object.fromEntries(
        Object.entries(MINK_DRAFT_CONFIG).map(([kind, config]) => [
          kind,
          config.expectedCredits,
        ]),
      ),
    ).toEqual({
      product_description: 2,
      product_seo: 1,
      blog: 5,
      coupon_email: 2,
      customer_message: 2,
    });
  });

  it("normalizes only the fields allowed by each draft kind", () => {
    expect(
      normalizeMinkDraftContent("product_seo", {
        seo_title: "  Summer shoes ",
        seo_description: " Shop the collection. ",
        unsafe: "ignored",
      }),
    ).toEqual({
      seo_title: "Summer shoes",
      seo_description: "Shop the collection.",
    });
  });

  it("rejects missing required fields and bounded overflows", () => {
    expect(() =>
      normalizeMinkDraftContent("customer_message", { body: "" }),
    ).toThrow("Message is required");
    expect(() =>
      normalizeMinkDraftContent("product_seo", {
        seo_title: "a".repeat(71),
        seo_description: "Valid",
      }),
    ).toThrow("SEO title must be at most 70");
  });

  it("shows a deterministic client estimate without treating it as billing", () => {
    expect(
      estimateMinkDraftIntent("Write a blog post about summer care"),
    ).toEqual({
      kind: "blog",
      label: "Blog post",
      expectedCredits: 5,
    });
    expect(estimateMinkDraftIntent("How many blogs do I have?")).toBeNull();
  });
});
