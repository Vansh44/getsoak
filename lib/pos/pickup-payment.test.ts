import { describe, it, expect } from "vitest";
import { amountDueAtCollection } from "./pickup-payment";

const order = (
  over: Partial<Parameters<typeof amountDueAtCollection>[0]> = {},
) => ({
  paymentMethod: "pay_at_store",
  paymentStatus: "pending",
  total: 340,
  ...over,
});

describe("amountDueAtCollection", () => {
  it("owes the full total on an unpaid pay-at-store order", () => {
    expect(amountDueAtCollection(order())).toBe(340);
  });

  it("owes nothing once it has been paid — a hand-over must not charge twice", () => {
    expect(amountDueAtCollection(order({ paymentStatus: "paid" }))).toBe(0);
  });

  it("★ owes nothing when the payment FAILED — a hand-over is not a settlement", () => {
    // Mirrors the CASE in markCollected's claim, which only moves
    // pending → paid. A failed payment must not be cleared by collecting.
    expect(amountDueAtCollection(order({ paymentStatus: "failed" }))).toBe(0);
  });

  it("owes nothing on an order paid online", () => {
    expect(
      amountDueAtCollection(
        order({ paymentMethod: "razorpay", paymentStatus: "paid" }),
      ),
    ).toBe(0);
  });

  it("★ owes nothing on a razorpay order still pending — that money is the gateway's to collect", () => {
    // The customer chose to pay online and didn't finish. The counter must not
    // become a second way to settle it, or the reaper and the till would race.
    expect(amountDueAtCollection(order({ paymentMethod: "razorpay" }))).toBe(0);
  });

  it("owes nothing on a delivery order's COD", () => {
    expect(
      amountDueAtCollection(order({ paymentMethod: "cash_on_delivery" })),
    ).toBe(0);
  });

  it("reads a numeric column that arrived as a string", () => {
    // Postgres NUMERIC comes back as a string over the wire; a bare `> 0` on it
    // would be a string compare.
    expect(amountDueAtCollection(order({ total: "1249.90" }))).toBe(1249.9);
  });

  it("rounds to paise so a float total can't drift into the drawer", () => {
    expect(amountDueAtCollection(order({ total: 99.999 }))).toBe(100);
  });

  it("treats missing, zero and nonsense totals as nothing owed", () => {
    for (const total of [null, 0, -5, Number.NaN, "abc"]) {
      expect(amountDueAtCollection(order({ total }))).toBe(0);
    }
  });

  it("survives a null method and status", () => {
    expect(
      amountDueAtCollection({
        paymentMethod: null,
        paymentStatus: null,
        total: 340,
      }),
    ).toBe(0);
  });
});
