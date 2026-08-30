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
      product_create: 3,
      coupon_create: 1,
      coupon_update: 1,
      customer_group_create: 1,
      customer_group_update: 1,
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
    expect(
      estimateMinkDraftIntent("Create a new product for masala tea"),
    ).toMatchObject({
      kind: "product_create",
      expectedCredits: 3,
    });
    expect(estimateMinkDraftIntent("Update coupon SAVE10")).toMatchObject({
      kind: "coupon_update",
      expectedCredits: 1,
    });
    expect(
      estimateMinkDraftIntent("Create a customer group for VIPs"),
    ).toMatchObject({
      kind: "customer_group_create",
      expectedCredits: 1,
    });
  });
});
