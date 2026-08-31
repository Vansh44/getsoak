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
      inventory_adjustment: 1,
    });
  });

  it("bounds single-SKU inventory proposals and requires accountable reasons", () => {
    expect(
      normalizeMinkDraftContent("inventory_adjustment", {
        quantity_change: " -12 ",
        reason: "damaged",
        note: "Counted by the warehouse manager.",
        product_id: "must be ignored",
      }),
    ).toEqual({
      quantity_change: "-12",
      reason: "damaged",
      note: "Counted by the warehouse manager.",
    });
    for (const quantity_change of ["0", "1.5", "1000001", "-1000001"]) {
      expect(() =>
        normalizeMinkDraftContent("inventory_adjustment", {
          quantity_change,
          reason: "correction",
        }),
      ).toThrow("non-zero whole number");
    }
    expect(() =>
      normalizeMinkDraftContent("inventory_adjustment", {
        quantity_change: "2",
        reason: "other",
        note: "",
      }),
    ).toThrow("audit note is required");
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
    expect(
      estimateMinkDraftIntent("Adjust stock for SKU TEA-500 by -2 in Delhi"),
    ).toMatchObject({ kind: "inventory_adjustment", expectedCredits: 1 });
  });
});
