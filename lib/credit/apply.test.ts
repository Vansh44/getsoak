import { describe, it, expect } from "vitest";
import { creditToApply } from "./apply";

describe("creditToApply", () => {
  it("applies the whole balance when the order is bigger", () => {
    const r = creditToApply({ orderTotal: 1000, balance: 300 });
    expect(r.applied).toBe(300);
    expect(r.remaining).toBe(700);
    expect(r.coversAll).toBe(false);
  });

  it("★ never applies more than is owed — no cash back through the side door", () => {
    const r = creditToApply({ orderTotal: 200, balance: 1000 });
    expect(r.applied).toBe(200);
    expect(r.remaining).toBe(0);
    expect(r.coversAll).toBe(true);
  });

  it("covers exactly, when it exactly covers", () => {
    const r = creditToApply({ orderTotal: 500, balance: 500 });
    expect(r.applied).toBe(500);
    expect(r.coversAll).toBe(true);
    expect(r.heldBackForMinimum).toBe(false);
  });

  it("applies nothing with no balance", () => {
    const r = creditToApply({ orderTotal: 500, balance: 0 });
    expect(r.applied).toBe(0);
    expect(r.remaining).toBe(500);
    expect(r.coversAll).toBe(false);
  });

  it("applies nothing to a zero-total order", () => {
    const r = creditToApply({ orderTotal: 0, balance: 500 });
    expect(r.applied).toBe(0);
    expect(r.coversAll).toBe(false);
  });

  describe("★ the unpayable-remainder gap", () => {
    it("holds credit back so the remainder clears the gateway minimum", () => {
      // ₹200.50 against ₹200 naively leaves ₹0.50 — which Razorpay rejects, so
      // checkout would fail on an order the customer nearly had credit for.
      const r = creditToApply({ orderTotal: 200.5, balance: 200 });
      expect(r.remaining).toBe(1);
      expect(r.applied).toBe(199.5);
      expect(r.heldBackForMinimum).toBe(true);
      expect(r.coversAll).toBe(false);
    });

    it("holds back for any sub-minimum remainder", () => {
      for (const total of [200.01, 200.5, 200.99]) {
        const r = creditToApply({ orderTotal: total, balance: 200 });
        expect(r.remaining).toBe(1);
        expect(r.heldBackForMinimum).toBe(true);
      }
    });

    it("does NOT hold back when the remainder is already payable", () => {
      const r = creditToApply({ orderTotal: 201, balance: 200 });
      expect(r.applied).toBe(200);
      expect(r.remaining).toBe(1);
      expect(r.heldBackForMinimum).toBe(false);
    });

    it("★ credit still covers an order SMALLER than the minimum", () => {
      // A ₹0.50 order can't leave ₹1 to charge. Covering it entirely is the
      // only payable outcome.
      const r = creditToApply({ orderTotal: 0.5, balance: 200 });
      expect(r.applied).toBe(0.5);
      expect(r.remaining).toBe(0);
      expect(r.coversAll).toBe(true);
    });

    it("the rule is off for COD and the counter, which have no floor", () => {
      const r = creditToApply({
        orderTotal: 200.5,
        balance: 200,
        gatewayMinimum: 0,
      });
      expect(r.applied).toBe(200);
      expect(r.remaining).toBe(0.5);
      expect(r.heldBackForMinimum).toBe(false);
    });

    it("holds back credit rather than spending money they didn't agree to", () => {
      // The rejected alternative was rounding UP to cover the whole order —
      // which spends the customer's credit to save them a rupee they were
      // willing to pay. The balance keeps the difference.
      const r = creditToApply({ orderTotal: 200.5, balance: 200 });
      expect(r.applied).toBeLessThan(200);
    });
  });

  it("works in paise, so float totals can't drift the split", () => {
    const r = creditToApply({ orderTotal: 0.1 + 0.2, balance: 0.3 });
    expect(r.applied).toBe(0.3);
    expect(r.coversAll).toBe(true);
  });

  it("shrugs off junk input", () => {
    const r = creditToApply({
      orderTotal: Number.NaN,
      balance: -50,
    });
    expect(r.applied).toBe(0);
    expect(r.remaining).toBe(0);
  });
});

describe("★ a total below the gateway minimum", () => {
  // Nothing can be charged online for these at all — Razorpay refuses under
  // ₹1 — so the only useful thing credit can do is cover the whole order and
  // remove the gateway from the picture entirely.

  it("covers the order outright when the balance can", () => {
    const r = creditToApply({ orderTotal: 0.5, balance: 5, gatewayMinimum: 1 });
    expect(r.applied).toBe(0.5);
    expect(r.remaining).toBe(0);
    expect(r.coversAll).toBe(true);
    // Nothing was held back — there was no chargeable remainder to protect.
    expect(r.heldBackForMinimum).toBe(false);
  });

  it("★ NEVER applies more credit than the customer holds", () => {
    // This branch used to read `applied = total`, so a ₹0.30 balance against
    // a ₹0.50 order quoted "₹0.50 applied". try_spend_customer_credit would
    // have refused to overdraw, so no balance was ever at risk — but the
    // checkout summary calls this same function, so the shopper was shown a
    // total the server would then decline to charge.
    const r = creditToApply({
      orderTotal: 0.5,
      balance: 0.3,
      gatewayMinimum: 1,
    });
    expect(r.applied).toBe(0.3);
    expect(r.remaining).toBe(0.2);
    // Honest: ₹0.20 is unpayable by any means, and saying so beats pretending
    // the order is settled.
    expect(r.coversAll).toBe(false);
  });

  it("applies the exact balance when it matches the total", () => {
    const r = creditToApply({
      orderTotal: 0.75,
      balance: 0.75,
      gatewayMinimum: 1,
    });
    expect(r.applied).toBe(0.75);
    expect(r.coversAll).toBe(true);
  });

  it("has no such problem when there is no gateway floor (COD)", () => {
    const r = creditToApply({
      orderTotal: 0.5,
      balance: 0.3,
      gatewayMinimum: 0,
    });
    expect(r.applied).toBe(0.3);
    expect(r.remaining).toBe(0.2);
  });
});

describe("the boundary around the minimum itself", () => {
  it("★ holds back only when a remainder would be UNPAYABLE", () => {
    // ₹1.50 order, ₹1.20 balance: the naive split leaves ₹0.30, which
    // Razorpay refuses. So less credit is applied to leave exactly ₹1.
    const r = creditToApply({
      orderTotal: 1.5,
      balance: 1.2,
      gatewayMinimum: 1,
    });
    expect(r.applied).toBe(0.5);
    expect(r.remaining).toBe(1);
    expect(r.heldBackForMinimum).toBe(true);
    expect(r.coversAll).toBe(false);
  });

  it("a total of exactly ₹1 covered in full needs no hold-back", () => {
    // No remainder means the gateway is never called, so its floor is
    // irrelevant — the order settles on credit alone.
    const r = creditToApply({ orderTotal: 1, balance: 5, gatewayMinimum: 1 });
    expect(r.applied).toBe(1);
    expect(r.remaining).toBe(0);
    expect(r.coversAll).toBe(true);
    expect(r.heldBackForMinimum).toBe(false);
  });

  it("★ a balance that exactly covers a ₹1+ order still covers it", () => {
    // No remainder means the hold-back rule never engages — the gateway isn't
    // called at all, so its floor is irrelevant.
    const r = creditToApply({ orderTotal: 200, balance: 200 });
    expect(r.coversAll).toBe(true);
    expect(r.heldBackForMinimum).toBe(false);
  });
});
