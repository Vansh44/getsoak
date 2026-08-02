import { describe, it, expect } from "vitest";
import {
  RETURN_REASONS,
  RETURN_REASON_REGISTRY,
  feesFor,
  isReturnReason,
  returnReasonOptions,
  wantsPhoto,
} from "./reasons";

const FEES = { restockingFeePercent: 10, returnShippingFee: 50 };

describe("the registry", () => {
  it("has a definition for every reason", () => {
    for (const r of RETURN_REASONS) {
      const def = RETURN_REASON_REGISTRY[r];
      expect(def.label).toBeTruthy();
      expect(def.hint).toBeTruthy();
      expect(typeof def.merchantFault).toBe("boolean");
    }
    expect(returnReasonOptions()).toHaveLength(RETURN_REASONS.length);
  });

  it("★ treats every store failure as the merchant's fault", () => {
    // The list that waives fees. If a reason is ever moved off this, it starts
    // billing customers for the store's own mistakes.
    for (const r of [
      "damaged",
      "defective",
      "wrong_item",
      "not_as_described",
      "arrived_late",
    ] as const) {
      expect(RETURN_REASON_REGISTRY[r].merchantFault).toBe(true);
    }
  });

  it("★ treats every no-fault reason as the customer's", () => {
    for (const r of ["changed_mind", "size_fit", "other"] as const) {
      expect(RETURN_REASON_REGISTRY[r].merchantFault).toBe(false);
    }
  });

  it("validates unknown values", () => {
    expect(isReturnReason("damaged")).toBe(true);
    expect(isReturnReason("Damaged")).toBe(false);
    expect(isReturnReason("")).toBe(false);
    expect(isReturnReason(null)).toBe(false);
    expect(isReturnReason(42)).toBe(false);
  });
});

describe("feesFor", () => {
  it("charges the restocking fee and postage on a change of mind", () => {
    const fees = feesFor("changed_mind", FEES, 1000);
    expect(fees.restockingFee).toBe(100);
    expect(fees.returnShippingFee).toBe(50);
    expect(fees.totalDeduction).toBe(150);
    expect(fees.waived).toBe(false);
    expect(fees.returnPostagePaidBy).toBe("customer");
  });

  it("★ WAIVES everything when the store was at fault", () => {
    // The whole point of the module. A flat fee on every return bills the
    // customer for a parcel that arrived broken.
    for (const r of [
      "damaged",
      "defective",
      "wrong_item",
      "arrived_late",
    ] as const) {
      const fees = feesFor(r, FEES, 1000);
      expect(fees.totalDeduction).toBe(0);
      expect(fees.restockingFee).toBe(0);
      expect(fees.returnShippingFee).toBe(0);
      expect(fees.waived).toBe(true);
      expect(fees.returnPostagePaidBy).toBe("store");
    }
  });

  it("waives WHOLESALE, not proportionally", () => {
    // There is no defensible fraction of "we sent you a broken thing".
    expect(feesFor("defective", FEES, 99999).totalDeduction).toBe(0);
  });

  it("★ never lets the deduction exceed the goods value", () => {
    // A ₹50 flat postage fee on a ₹25 item would otherwise produce a NEGATIVE
    // refund — the customer owing money for sending something back.
    const fees = feesFor("changed_mind", FEES, 25);
    expect(fees.totalDeduction).toBe(25);
    expect(fees.totalDeduction).toBeLessThanOrEqual(25);
  });

  it("★ an absent reason is NOT treated as the merchant's fault", () => {
    // The generous reading would let anyone waive fees by not answering.
    expect(feesFor(null, FEES, 1000).waived).toBe(false);
    expect(feesFor(undefined, FEES, 1000).totalDeduction).toBe(150);
  });

  it("charges nothing when the store configured no fees", () => {
    const fees = feesFor(
      "changed_mind",
      {
        restockingFeePercent: 0,
        returnShippingFee: 0,
      },
      1000,
    );
    expect(fees.totalDeduction).toBe(0);
    // Still not "waived" — no fees were charged because none exist, which is
    // a different fact from the store having been at fault.
    expect(fees.waived).toBe(false);
  });

  it("clamps a nonsense percentage rather than inventing money", () => {
    expect(
      feesFor(
        "changed_mind",
        { restockingFeePercent: 500, returnShippingFee: 0 },
        100,
      ).totalDeduction,
    ).toBe(100);
    expect(
      feesFor(
        "changed_mind",
        { restockingFeePercent: -20, returnShippingFee: 0 },
        100,
      ).totalDeduction,
    ).toBe(0);
  });

  it("handles a zero-value return without dividing by anything", () => {
    expect(feesFor("changed_mind", FEES, 0).totalDeduction).toBe(0);
  });

  it("rounds to paise", () => {
    const fees = feesFor(
      "changed_mind",
      { restockingFeePercent: 10, returnShippingFee: 0 },
      33.33,
    );
    expect(fees.restockingFee).toBe(3.33);
  });
});

describe("wantsPhoto", () => {
  it("asks only when a photo could settle the claim", () => {
    expect(wantsPhoto("damaged", true)).toBe(true);
    expect(wantsPhoto("wrong_item", true)).toBe(true);
    // A picture proves nothing about someone changing their mind.
    expect(wantsPhoto("changed_mind", true)).toBe(false);
    expect(wantsPhoto("size_fit", true)).toBe(false);
    expect(wantsPhoto("arrived_late", true)).toBe(false);
  });

  it("never asks when the store hasn't switched it on", () => {
    expect(wantsPhoto("damaged", false)).toBe(false);
  });

  it("never asks without a reason to ask about", () => {
    expect(wantsPhoto(null, true)).toBe(false);
  });
});
