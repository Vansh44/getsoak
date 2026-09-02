import { describe, it, expect } from "vitest";
import { offerBadgeFor, type BadgeProduct } from "./badge";
import type { Offer } from "./types";

const policy = {
  onSalePrice: "best" as const,
  maxTotalDiscountPercent: 50,
  autoApply: true,
};
const NOW = new Date("2026-09-02T10:00:00.000Z");

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: "o1",
    name: "Shake sale",
    status: "active",
    delivery: "automatic",
    code: null,
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    validFrom: null,
    validUntil: null,
    channels: [],
    locationIds: [],
    groupIds: [],
    trigger: { type: "always" },
    reward: { type: "percent_off_items", percent: 20 },
    productIds: [],
    variantIds: [],
    categoryIds: [],
    ...over,
  };
}

const product = (over: Partial<BadgeProduct> = {}): BadgeProduct => ({
  productId: "p1",
  variantId: null,
  categoryId: "c1",
  unitPrice: 1000,
  ...over,
});

describe("offerBadgeFor", () => {
  it("shows a percentage for a percentage reward", () => {
    const b = offerBadgeFor(product(), [offer()], policy, NOW);
    expect(b).toMatchObject({ label: "20% off", saving: 200 });
  });

  it("shows money saved for a fixed price, which varies per product", () => {
    const fixed = offer({ reward: { type: "fixed_price", unitPrice: 499 } });
    expect(
      offerBadgeFor(product({ unitPrice: 800 }), [fixed], policy, NOW),
    ).toMatchObject({ label: "Save ₹301" });
    expect(
      offerBadgeFor(product({ unitPrice: 1200 }), [fixed], policy, NOW),
    ).toMatchObject({ label: "Save ₹701" });
  });

  it("shows nothing when the offer does not cover the product", () => {
    const scoped = offer({ categoryIds: ["other"] });
    expect(offerBadgeFor(product(), [scoped], policy, NOW)).toBeNull();
  });

  it("★ shows nothing for an ORDER-level offer — it is not a fact about this product", () => {
    const orderOffer = offer({ reward: { type: "percent_off", percent: 20 } });
    expect(offerBadgeFor(product(), [orderOffer], policy, NOW)).toBeNull();
  });

  it("★ shows nothing when `skip` declines an on-sale product", () => {
    const onSale = product({ unitPrice: 800, regularUnitPrice: 1000 });
    expect(
      offerBadgeFor(onSale, [offer()], { ...policy, onSalePrice: "skip" }, NOW),
    ).toBeNull();
  });

  it("★ shows nothing when `best` means the offer adds nothing", () => {
    // 10% off ₹1,000 = ₹900, which is worse than the ₹800 special price.
    const onSale = product({ unitPrice: 800, regularUnitPrice: 1000 });
    const weak = offer({ reward: { type: "percent_off_items", percent: 10 } });
    expect(offerBadgeFor(onSale, [weak], policy, NOW)).toBeNull();
  });

  it("shows only the difference when `best` beats the special price", () => {
    // 30% off ₹1,000 = ₹700, beating the ₹800 special by ₹100.
    const onSale = product({ unitPrice: 800, regularUnitPrice: 1000 });
    const deep = offer({ reward: { type: "percent_off_items", percent: 30 } });
    expect(offerBadgeFor(onSale, [deep], policy, NOW)?.saving).toBe(100);
  });

  it("shows nothing for a fixed price above the product's price", () => {
    const fixed = offer({ reward: { type: "fixed_price", unitPrice: 999 } });
    expect(
      offerBadgeFor(product({ unitPrice: 500 }), [fixed], policy, NOW),
    ).toBeNull();
  });

  it("picks the better of two competing offers, like the cart would", () => {
    const b = offerBadgeFor(
      product(),
      [
        offer({
          id: "small",
          reward: { type: "percent_off_items", percent: 10 },
        }),
        offer({
          id: "big",
          reward: { type: "percent_off_items", percent: 40 },
        }),
      ],
      policy,
      NOW,
    );
    expect(b?.offerId).toBe("big");
    expect(b?.saving).toBe(400);
  });

  it("★ is NOT capped by the per-order ceiling — one item is not an order", () => {
    // 80% off with a 50% order ceiling: the item genuinely saves 80%.
    const deep = offer({ reward: { type: "percent_off_items", percent: 80 } });
    expect(offerBadgeFor(product(), [deep], policy, NOW)?.saving).toBe(800);
  });

  it("respects the offer's own window and status", () => {
    const expired = offer({ validUntil: "2026-01-01T00:00:00.000Z" });
    expect(offerBadgeFor(product(), [expired], policy, NOW)).toBeNull();
    const off = offer({ status: "disabled" });
    expect(offerBadgeFor(product(), [off], policy, NOW)).toBeNull();
  });

  it("shows nothing on an empty offer list or a free product", () => {
    expect(offerBadgeFor(product(), [], policy, NOW)).toBeNull();
    expect(
      offerBadgeFor(product({ unitPrice: 0 }), [offer()], policy, NOW),
    ).toBeNull();
  });
});
