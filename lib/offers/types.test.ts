import { describe, it, expect } from "vitest";
import {
  decodeConditions,
  decodeReward,
  decodeTrigger,
  isContentsTrigger,
  OFFER_TRIGGERS,
  validateOfferConditions,
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

describe("offer conditions — decoding", () => {
  it("keeps every supported condition", () => {
    const { conditions, dropped } = decodeConditions([
      { type: "first_order" },
      { type: "payment_method", methods: ["razorpay", "cod"] },
      { type: "fulfilment_type", fulfilment: ["pickup"] },
      { type: "time_window", days: [1, 5], startMinute: 600, endMinute: 720 },
    ]);
    expect(dropped).toBe(false);
    expect(conditions).toHaveLength(4);
  });

  it("★ FLAGS an unknown type rather than treating it as no condition", () => {
    // Dropping it silently would WIDEN the offer: one restricted to first
    // orders would start discounting every order, with nothing to see. The
    // engine refuses an offer whose conditions could not be read.
    const { conditions, dropped } = decodeConditions([{ type: "astrology" }]);
    expect(conditions).toEqual([]);
    expect(dropped).toBe(true);
  });

  it("flags a non-array value", () => {
    expect(decodeConditions({ type: "first_order" }).dropped).toBe(true);
  });

  it("treats an empty allowlist as broken, not as unrestricted", () => {
    // ★ An empty list can never hold, so reading it as "any method" would
    // apply an offer the merchant meant to restrict.
    for (const bad of [
      { type: "payment_method", methods: [] },
      { type: "payment_method" },
      { type: "fulfilment_type", fulfilment: [] },
    ]) {
      const r = decodeConditions([bad]);
      expect(r.conditions).toEqual([]);
      expect(r.dropped).toBe(true);
    }
  });

  it("drops unknown values inside a known allowlist", () => {
    const { conditions } = decodeConditions([
      { type: "payment_method", methods: ["razorpay", "bitcoin"] },
    ]);
    expect(conditions).toEqual([
      { type: "payment_method", methods: ["razorpay"] },
    ]);
  });

  it("normalises a time window and rejects an impossible one", () => {
    const { conditions } = decodeConditions([
      {
        type: "time_window",
        days: [5, 1, 1, 9],
        startMinute: 60,
        endMinute: 120,
      },
    ]);
    expect(conditions[0]).toEqual({
      type: "time_window",
      days: [1, 5],
      startMinute: 60,
      endMinute: 120,
    });

    for (const bad of [
      { type: "time_window", days: [], startMinute: 0, endMinute: 60 },
      { type: "time_window", days: [1], startMinute: 600, endMinute: 600 },
      { type: "time_window", days: [1], startMinute: 0, endMinute: 1440 },
      { type: "time_window", days: [1] },
    ]) {
      expect(decodeConditions([bad]).dropped).toBe(true);
    }
  });

  it("reads no conditions as no conditions, not as broken", () => {
    for (const empty of [null, undefined, []]) {
      expect(decodeConditions(empty)).toEqual({
        conditions: [],
        dropped: false,
      });
    }
  });
});

describe("offer conditions — validation", () => {
  const problems = (
    conditions: Parameters<typeof validateOfferConditions>[0],
    channels: string[] = ["storefront"],
  ) => validateOfferConditions(conditions, channels).map((i) => i.message);

  it("accepts a website-only condition on a website offer", () => {
    expect(
      problems([{ type: "payment_method", methods: ["razorpay"] }]),
    ).toEqual([]);
  });

  it("★ REFUSES a payment-method condition that reaches the register", () => {
    // The till quotes the total BEFORE payment is staged, so a tender-dependent
    // discount would make the screen and the sale disagree.
    const [msg] = problems(
      [{ type: "payment_method", methods: ["razorpay"] }],
      ["pos"],
    );
    expect(msg).toContain("only works on your website");
  });

  it("★ REFUSES it for an offer with NO channels, because that means every channel", () => {
    const [msg] = problems(
      [{ type: "payment_method", methods: ["razorpay"] }],
      [],
    );
    expect(msg).toContain("only works on your website");
  });

  it("refuses a fulfilment condition at the register — a sale there is neither", () => {
    const [msg] = problems(
      [{ type: "fulfilment_type", fulfilment: ["pickup"] }],
      ["pos"],
    );
    expect(msg).toContain("register sale is neither");
  });

  it("allows first-order and time conditions at the register", () => {
    expect(
      problems(
        [
          { type: "first_order" },
          { type: "time_window", days: [1], startMinute: 60, endMinute: 120 },
        ],
        ["pos"],
      ),
    ).toEqual([]);
  });

  it("refuses the same kind twice", () => {
    const [msg] = problems([{ type: "first_order" }, { type: "first_order" }]);
    expect(msg).toContain("only be added once");
  });

  it("refuses an empty-window and an empty-day condition", () => {
    expect(
      problems([
        { type: "time_window", days: [], startMinute: 60, endMinute: 120 },
      ]).length,
    ).toBeGreaterThan(0);
    expect(
      problems([
        { type: "time_window", days: [1], startMinute: 600, endMinute: 600 },
      ]).length,
    ).toBeGreaterThan(0);
  });
});

describe("decodeTrigger — the vocabulary that silently lost two members", () => {
  /**
   * ★★ THE REGRESSION THIS PINS. `loadLiveOffers` wrote the trigger by hand as
   * `type === "min_subtotal" ? "min_subtotal" : "always"`. That was true while
   * there were two trigger types and silently WRONG once Phase B added
   * `contains_product`/`contains_category`: both collapsed to `always`, so
   * `isContentsTrigger` was false, `disqualify` never ran the contents check,
   * and "10% off your order when it includes a shake" discounted EVERY order.
   *
   * Nothing failed anywhere — the editor round-tripped it, the DB stored it,
   * the summary sentence described it. The only symptom was money leaving.
   * Two lines from `decodeReward`, which exists for exactly this reason.
   */
  it.each(OFFER_TRIGGERS)("keeps %s intact", (type) => {
    expect(decodeTrigger(type, {}).type).toBe(type);
  });

  it("a contents trigger survives as a CONTENTS trigger", () => {
    // The single assertion that would have caught it: the collapsed value was
    // a legal `OfferTriggerType`, so only `isContentsTrigger` tells them apart.
    expect(isContentsTrigger(decodeTrigger("contains_category", {}).type)).toBe(
      true,
    );
    expect(isContentsTrigger(decodeTrigger("contains_product", {}).type)).toBe(
      true,
    );
    expect(isContentsTrigger(decodeTrigger("min_subtotal", {}).type)).toBe(
      false,
    );
  });

  it("carries the threshold, and treats a missing one as absent", () => {
    expect(decodeTrigger("min_subtotal", { minSubtotal: 1500 })).toEqual({
      type: "min_subtotal",
      minSubtotal: 1500,
    });
    expect(decodeTrigger("min_subtotal", {}).minSubtotal).toBeUndefined();
    expect(
      decodeTrigger("min_subtotal", { minSubtotal: "x" }).minSubtotal,
    ).toBeUndefined();
  });

  it("falls back to the WIDEST trigger on an unknown stored value", () => {
    // `always` can only make an offer easier to qualify for. Falling back to a
    // narrower one would silently withdraw an offer the merchant configured.
    expect(decodeTrigger("something_new", {}).type).toBe("always");
  });
});
