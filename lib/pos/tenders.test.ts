// What the till may be paid with, and whether a payment settles a total.
//
// This module is a SECURITY boundary — the allowlist decides what the server
// will accept from any caller, not just the register's own JavaScript — and it
// had no test file at all until the overpayment hole below was found.

import { describe, it, expect } from "vitest";
import {
  settleTenders,
  validateTenderShape,
  TENDER_METHODS,
  COUNTER_TENDER_METHODS,
  MAX_TENDERS,
  type PosTender,
} from "./tenders";

const cash = (amount: number): PosTender => ({ method: "cash", amount });
const card = (amount: number): PosTender => ({ method: "card", amount });
const upi = (amount: number): PosTender => ({ method: "upi", amount });

describe("the allowlist", () => {
  it("★★ refuses gift_card — there is no ledger behind it", () => {
    // Accepting one would mark a sale paid in full, and let the goods leave the
    // shelf, against money that never existed.
    expect(
      validateTenderShape([{ method: "gift_card", amount: 10 }] as never, "x"),
    ).toMatch(/invalid payment method/i);
  });

  // ★★ store_credit is settleable at BOTH counters now (§29). It was the sell
  // counter only for as long as markCollected had no spend wired — and sharing
  // one global list during that window is exactly what would have marked a
  // collection paid against a balance nothing deducted.
  it("accepts store_credit at the sell counter", () => {
    expect(
      validateTenderShape(
        [{ method: "store_credit", amount: 10 }] as never,
        "x",
      ),
    ).toBeNull();
  });

  it("★★ accepts store_credit at the collection counter too", () => {
    // It was refused here for exactly as long as markCollected had no spend
    // wired. That action now spends the balance INSIDE the same transaction as
    // its hand-over claim, so the shape is settleable at both counters.
    expect(
      validateTenderShape(
        [{ method: "store_credit", amount: 10 }] as never,
        "x",
        COUNTER_TENDER_METHODS,
      ),
    ).toBeNull();
  });

  // ★★ THE TWO LISTS ARE EQUAL TODAY, and this asserts it WITHOUT asserting
  // they must stay equal. Both exclusions were closed in order — razorpay when
  // markCollected gained gateway verification, store_credit when it gained the
  // spend — so there is nothing the sell counter can settle that the collection
  // counter cannot.
  //
  // ⚠ The next method added to TENDER_METHODS (a gift card, most likely) will
  // land on the sell counter first, and this test SHOULD fail then. That is the
  // point: it forces a deliberate decision about whether markCollected can
  // settle it, rather than letting a shared constant grant it silently.
  it("the collection counter can settle everything the sell counter can", () => {
    const extra = TENDER_METHODS.filter(
      (m) => !COUNTER_TENDER_METHODS.includes(m),
    );
    expect(extra).toEqual([]);
  });

  it("★★ accepts a gateway tender now that markCollected verifies one", () => {
    // It was OFF this list for exactly as long as `placePosSale` was the only
    // action reading a payment back from Razorpay. Both counters now run the
    // same verifyGatewayTenders, so the shape is settleable at both.
    //
    // ⚠ Being on the list is NOT the gate — it says the SHAPE is settleable.
    // markCollected still proves the money exists before its claim.
    expect(
      validateTenderShape(
        [{ method: "razorpay", amount: 10, reference: "pay_x" }] as never,
        "x",
        COUNTER_TENDER_METHODS,
      ),
    ).toBeNull();
  });

  it("the collection counter still takes the money instruments", () => {
    for (const method of ["cash", "card", "upi"] as const) {
      expect(
        validateTenderShape(
          [{ method, amount: 10 }],
          "x",
          COUNTER_TENDER_METHODS,
        ),
      ).toBeNull();
    }
  });

  it("refuses an unknown method outright", () => {
    expect(
      validateTenderShape(
        [{ method: "bitcoin" as never, amount: 100 }],
        "empty",
      ),
    ).toBe("Invalid payment method.");
  });

  it("★ refuses zero, negative and non-finite amounts", () => {
    for (const bad of [0, -50, NaN, Infinity]) {
      expect(validateTenderShape([cash(bad)], "empty")).toBe(
        "Invalid payment amount.",
      );
    }
  });

  it("caps the number of tenders — more is a stuck button, not a split", () => {
    const many = Array.from({ length: MAX_TENDERS + 1 }, () => cash(10));
    expect(validateTenderShape(many, "empty")).toBe("Too many payments.");
  });

  it("uses the caller's wording for an empty payment", () => {
    expect(validateTenderShape([], "Take the ₹40 owed.")).toBe(
      "Take the ₹40 owed.",
    );
  });
});

describe("settling a total", () => {
  it("exact cash settles with no change", () => {
    expect(settleTenders([cash(100)], 100)).toEqual({ paid: 100, change: 0 });
  });

  it("refuses a payment that doesn't cover the total", () => {
    const r = settleTenders([cash(99)], 100);
    expect(r).toHaveProperty("error");
  });

  it("★ compares in paise, so an exactly-covering payment is not refused", () => {
    // A rupee-float compare refuses this: 238.1 + 11.8 === 249.90000000000003.
    expect(settleTenders([cash(238.1), card(11.8)], 249.9)).toMatchObject({
      change: 0,
    });
  });

  it("gives change on over-handed cash", () => {
    expect(settleTenders([cash(500)], 343)).toEqual({ paid: 500, change: 157 });
  });

  it("★ a UPI payment over the total is refused, and says why", () => {
    // Before the overpayment rule this returned "Only a cash payment can
    // produce change", which is true and useless to a cashier who has just
    // typed the wrong figure into the UPI field.
    const r = settleTenders([upi(500)], 343);
    expect((r as { error: string }).error).toMatch(/can't be more than/);
  });
});

describe("★★ a non-cash tender may never exceed the total", () => {
  // The regression this file was written for. Guarding only "change requires a
  // cash tender" reads as the same rule and is not — one token cash tender
  // satisfied it, and the excess left the drawer as change.

  it("card ₹100,000 + cash ₹50 on a ₹100 sale is REFUSED", () => {
    const r = settleTenders([cash(50), card(100_000)], 100);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/can't be more than/);
  });

  it("the same trick with UPI is refused", () => {
    expect(settleTenders([cash(1), upi(5_000)], 200)).toHaveProperty("error");
  });

  it("★ split non-cash tenders are refused on their SUM, not one at a time", () => {
    // 60 + 60 = 120 against a 100 total. Neither alone exceeds it.
    expect(settleTenders([cash(1), card(60), upi(60)], 100)).toHaveProperty(
      "error",
    );
  });

  it("a card covering the total exactly still works", () => {
    expect(settleTenders([card(100)], 100)).toEqual({ paid: 100, change: 0 });
  });

  it("★ the ordinary split still works — card part, cash part, change from cash", () => {
    // The case the rule must not break: ₹60 on card, ₹50 cash handed over for
    // the remaining ₹40, ₹10 back.
    expect(settleTenders([card(60), cash(50)], 100)).toEqual({
      paid: 110,
      change: 10,
    });
  });

  it("★ paise tolerance is preserved — a rounding sliver is not an overpayment", () => {
    // card 249.90 against a total that floats to 249.90000000000003 must not
    // be read as exceeding it.
    expect(settleTenders([card(238.1), card(11.8)], 249.9)).toMatchObject({
      change: 0,
    });
  });
});
