import { describe, it, expect } from "vitest";
import {
  decodeReward,
  validateOfferRule,
  rewardLevel,
  isGroupReward,
  sortedTiers,
  sortedBreaks,
  type OfferReward,
} from "./types";

function issues(reward: OfferReward) {
  return validateOfferRule({ type: "always" }, reward).map((i) => i.field);
}

describe("ladder rewards — shape", () => {
  it("a quantity ladder is a GROUP reward, because units are counted together", () => {
    // Evaluated per line, six of one flavour and six of another would find six
    // and six and award nothing — the opposite of a case price.
    expect(isGroupReward("volume_break")).toBe(true);
    expect(rewardLevel("volume_break")).toBe("line");
  });

  it("a spend ladder discounts the ORDER, so scope only qualifies", () => {
    expect(rewardLevel("tiered")).toBe("order");
    expect(isGroupReward("tiered")).toBe(false);
  });

  it("normalises rungs low-to-high, dropping impossible ones", () => {
    expect(
      sortedTiers([
        { minSubtotal: 2000, value: 10 },
        { minSubtotal: -1, value: 5 },
        { minSubtotal: 1000, value: 5 },
      ]).map((t) => t.minSubtotal),
    ).toEqual([1000, 2000]);

    expect(
      sortedBreaks([
        { minQuantity: 12, percent: 15 },
        { minQuantity: 0, percent: 5 },
        { minQuantity: 6, percent: 10 },
      ]).map((b) => b.minQuantity),
    ).toEqual([6, 12]);
  });
});

describe("ladder rewards — validation", () => {
  it("accepts a rising ladder", () => {
    expect(
      issues({
        type: "tiered",
        tierMode: "percent",
        tiers: [
          { minSubtotal: 1000, value: 5 },
          { minSubtotal: 2000, value: 10 },
        ],
      }),
    ).toEqual([]);
  });

  it("refuses a ladder that does not go up", () => {
    // ★ A higher spend earning LESS is always a mistake, and it is invisible on
    // a form that lists the rungs in entry order.
    expect(
      issues({
        type: "tiered",
        tierMode: "percent",
        tiers: [
          { minSubtotal: 1000, value: 10 },
          { minSubtotal: 2000, value: 10 },
        ],
      }),
    ).toEqual(["reward.tiers"]);
  });

  it("refuses two rungs at the same threshold rather than collapsing them", () => {
    expect(
      issues({
        type: "tiered",
        tierMode: "percent",
        tiers: [
          { minSubtotal: 1000, value: 5 },
          { minSubtotal: 1000, value: 10 },
        ],
      }),
    ).toEqual(["reward.tiers"]);
  });

  it("refuses an empty ladder", () => {
    expect(issues({ type: "tiered", tierMode: "percent", tiers: [] })).toEqual([
      "reward.tiers",
    ]);
    expect(issues({ type: "volume_break", breaks: [] })).toEqual([
      "reward.breaks",
    ]);
  });

  it("bounds a percentage rung to 1–100", () => {
    expect(
      issues({
        type: "tiered",
        tierMode: "percent",
        tiers: [{ minSubtotal: 1000, value: 150 }],
      }),
    ).toEqual(["reward.tiers"]);
  });

  it("allows a rupee rung above 100, which a percentage one may not be", () => {
    expect(
      issues({
        type: "tiered",
        tierMode: "amount",
        tiers: [{ minSubtotal: 5000, value: 500 }],
      }),
    ).toEqual([]);
  });

  it("refuses a quantity rung below one item", () => {
    expect(
      issues({
        type: "volume_break",
        breaks: [{ minQuantity: 0, percent: 10 }],
      }),
    ).toEqual(["reward.breaks"]);
  });

  it("refuses a quantity ladder that does not go up", () => {
    expect(
      issues({
        type: "volume_break",
        breaks: [
          { minQuantity: 6, percent: 15 },
          { minQuantity: 12, percent: 10 },
        ],
      }),
    ).toEqual(["reward.breaks"]);
  });

  it("caps a ladder at ten rungs", () => {
    const tiers = Array.from({ length: 11 }, (_, i) => ({
      minSubtotal: (i + 1) * 100,
      value: i + 1,
    }));
    expect(issues({ type: "tiered", tierMode: "percent", tiers })).toEqual([
      "reward.tiers",
    ]);
  });
});

describe("decodeReward — the round trip that was silently lossy", () => {
  /**
   * ★★ THE REGRESSION THIS PINS. `loadLiveOffers` used to copy `percent` and
   * `amount` out of `reward_config` by hand and nothing else, so a correctly
   * saved "buy 1 get 1 free" reached the engine with `buyQuantity` undefined
   * and discounted NOTHING — with an active badge in the offers list, a correct
   * live summary in the editor, and no error anywhere. Every field the editor
   * can write is asserted here, so adding a reward field without teaching the
   * decoder fails the suite instead of failing a customer at checkout.
   */
  it("survives every field the offer editor can store", () => {
    const stored = {
      percent: 15,
      amount: 250,
      unitPrice: 99,
      buyQuantity: 2,
      getQuantity: 1,
      getPercent: 50,
      maxSets: 3,
      tierMode: "amount",
      tiers: [{ minSubtotal: 1000, value: 100 }],
      breaks: [{ minQuantity: 6, percent: 10 }],
    };
    expect(decodeReward("buy_x_get_y", stored)).toEqual({
      type: "buy_x_get_y",
      ...stored,
    });
  });

  it("returns a buy-X-get-Y the engine can actually act on", () => {
    const r = decodeReward("buy_x_get_y", {
      buyQuantity: 1,
      getQuantity: 1,
      getPercent: 100,
    });
    expect(r.buyQuantity).toBe(1);
    expect(r.getQuantity).toBe(1);
  });

  it("keeps a fixed price, which was also being dropped", () => {
    expect(decodeReward("fixed_price", { unitPrice: 49 }).unitPrice).toBe(49);
  });

  it("drops rungs with no threshold or no value rather than inventing one", () => {
    const r = decodeReward("tiered", {
      tiers: [
        { minSubtotal: 1000, value: 5 },
        { value: 10 },
        { minSubtotal: 3000 },
      ],
    });
    expect(r.tiers).toEqual([{ minSubtotal: 1000, value: 5 }]);
  });

  it("treats an empty or absent config as no reward values, never NaN", () => {
    for (const cfg of [null, undefined, {}, { percent: "abc" }]) {
      const r = decodeReward("percent_off", cfg);
      expect(r.percent).toBeUndefined();
      expect(r.type).toBe("percent_off");
    }
  });

  it("falls back to a known reward type rather than trusting the column", () => {
    // An unrecognised value would otherwise flow into the engine's switch and
    // silently match nothing.
    expect(decodeReward("something_new", {}).type).toBe("percent_off");
  });

  it("defaults a spend ladder to percentages, so a missing mode is not a rupee ladder", () => {
    // ★ Reading a percent ladder as rupees turns "10% off" into "₹10 off" —
    // wrong in the merchant's favour, and invisible on a small order.
    expect(
      decodeReward("tiered", { tiers: [{ minSubtotal: 1, value: 10 }] })
        .tierMode,
    ).toBeUndefined();
  });
});
