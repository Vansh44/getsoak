import { describe, it, expect } from "vitest";
import { describeReward, describeTrigger } from "./describe";
import { OFFER_REWARDS, OFFER_TRIGGERS } from "./types";

// ★★ THE BUG THIS MODULE EXISTS FOR. The offers LIST had a three-branch stub
// written when there were three reward types and never extended, so every type
// added by Phases C–H fell through to `${percent ?? 0}% off`. A merchant's
// working "buy 1, get 1 free" was listed as **"0% off"** — the offer worked and
// the dashboard said it gave nothing.

const BASE = {
  percent: null,
  amount: null,
  unitPrice: null,
  buyQuantity: null,
  getQuantity: null,
  getPercent: null,
  tierMode: "percent" as const,
  tiers: [],
  breaks: [],
  giftQuantity: null,
  bundleQuantity: null,
  bundlePrice: null,
  creditAmount: null,
};

describe("describeReward", () => {
  it("describes buy X get Y — the case the old stub called “0% off”", () => {
    expect(
      describeReward({
        ...BASE,
        rewardType: "buy_x_get_y",
        buyQuantity: 1,
        getQuantity: 1,
        getPercent: 100,
      }),
    ).toBe("Buy 1, get 1 free");
  });

  it("says half price rather than free when the percentage is partial", () => {
    expect(
      describeReward({
        ...BASE,
        rewardType: "buy_x_get_y",
        buyQuantity: 1,
        getQuantity: 1,
        getPercent: 50,
      }),
    ).toBe("Buy 1, get 1 at 50% off");
  });

  // ★★ THE GUARD THAT MATTERS. Not "these eleven strings are right" — that is
  // a snapshot — but that NO reward type silently reads as a percentage it does
  // not have. That is the exact shape of the original bug, and it is what a
  // twelfth reward type would reintroduce.
  it("never describes a non-percentage reward as a percentage", () => {
    const percentish = new Set(["percent_off", "percent_off_items"]);
    for (const rewardType of OFFER_REWARDS) {
      const text = describeReward({ ...BASE, rewardType });
      expect(text, rewardType).toBeTruthy();
      if (!percentish.has(rewardType)) {
        expect(text, rewardType).not.toMatch(/^0% off/);
      }
    }
  });

  it("covers every reward type with a distinct phrase", () => {
    const seen = OFFER_REWARDS.map((rewardType) =>
      describeReward({ ...BASE, rewardType }),
    );
    expect(new Set(seen).size).toBe(OFFER_REWARDS.length);
  });

  it("names the gift when the caller can resolve it, and hedges when it cannot", () => {
    const r = { ...BASE, rewardType: "free_item" as const, giftQuantity: 2 };
    expect(describeReward(r, { giftName: "Tote bag" })).toBe(
      "Free Tote bag × 2",
    );
    expect(describeReward(r)).toBe("Free a gift × 2");
  });

  it("appends the scope count only when the caller supplies one", () => {
    const r = {
      ...BASE,
      rewardType: "percent_off_items" as const,
      percent: 20,
    };
    expect(describeReward(r, { scopeCount: 3 })).toBe(
      "20% off chosen items (3 selected)",
    );
    // ⚠ The LIST does not load scope rows, so it passes nothing — and must not
    // be given a fabricated "(0 selected)".
    expect(describeReward(r)).toBe("20% off chosen items");
  });

  it("reads a ladder back as its rungs, and says so when there are none", () => {
    expect(
      describeReward({
        ...BASE,
        rewardType: "tiered",
        tiers: [
          { minSubtotal: 1000, value: 10 },
          { minSubtotal: 2000, value: 15 },
        ],
      }),
    ).toBe(
      "Order discount by level: over ₹1,000 → 10% off, over ₹2,000 → 15% off",
    );
    expect(describeReward({ ...BASE, rewardType: "tiered" })).toBe(
      "Order discount by level: no levels yet",
    );
  });
});

describe("describeTrigger", () => {
  it("covers every trigger", () => {
    for (const t of OFFER_TRIGGERS) {
      expect(describeTrigger(t, 500), t).toBeTruthy();
    }
    expect(describeTrigger("always", null)).toBe("on any order");
    expect(describeTrigger("min_subtotal", 1500)).toBe("on orders over ₹1,500");
  });
});
