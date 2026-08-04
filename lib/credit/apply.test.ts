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
