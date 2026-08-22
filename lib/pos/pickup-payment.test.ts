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

// ── Part payment (roadmap Step 18) ─────────────────────────────────────────
// A deposit at the counter. Without `paidSoFar` the customer would be asked for
// the full amount again on their next visit — ₹540 taken for a ₹340 order, and
// a drawer reporting OVER by the deposit.

describe("amountDueAtCollection — net of what is already paid", () => {
  const owing = (over: Record<string, unknown> = {}) => ({
    paymentMethod: "pay_at_store",
    paymentStatus: "pending",
    total: 340,
    ...over,
  });

  it("★★ subtracts a deposit already taken", () => {
    expect(amountDueAtCollection(owing({ paidSoFar: 200 }))).toBe(140);
  });

  it("a fully-paid collection owes nothing more", () => {
    expect(amountDueAtCollection(owing({ paidSoFar: 340 }))).toBe(0);
  });

  it("★ over-payment floors at zero, it does not go negative", () => {
    // A negative would make the tender pad ask for a negative amount. Money
    // back is a refund, which is its own path (§26).
    expect(amountDueAtCollection(owing({ paidSoFar: 400 }))).toBe(0);
  });

  it("★★ a malformed figure means NOTHING paid, never paid-in-full", () => {
    // Reading a bad value as settled would hand the goods over free.
    for (const bad of [null, undefined, "abc", NaN, -50]) {
      expect(amountDueAtCollection(owing({ paidSoFar: bad }))).toBe(340);
    }
  });

  it("numeric strings from the wire are handled", () => {
    expect(amountDueAtCollection(owing({ paidSoFar: "200.00" }))).toBe(140);
  });

  it("★ an already-PAID order is still 0, whatever paidSoFar says", () => {
    // The status gate comes first: an order paid online must never be charged
    // a second time, and a stray payments row must not resurrect a debt.
    expect(
      amountDueAtCollection({
        paymentMethod: "razorpay",
        paymentStatus: "paid",
        total: 340,
        paidSoFar: 0,
      }),
    ).toBe(0);
  });

  it("rounds to paise like every other money figure here", () => {
    expect(
      amountDueAtCollection(owing({ total: 100, paidSoFar: 33.333 })),
    ).toBe(66.67);
  });
});
