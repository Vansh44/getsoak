import { describe, it, expect } from "vitest";
import { computeTax, round2 } from "./tax";

describe("round2", () => {
  it("rounds to 2 decimals and guards non-finite", () => {
    expect(round2(18.005)).toBe(18.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(NaN)).toBe(0);
    expect(round2(Infinity)).toBe(0);
  });
});

describe("computeTax", () => {
  it("returns zero tax when disabled", () => {
    const r = computeTax({
      lines: [{ amount: 100, rate: 18 }],
      enabled: false,
    });
    expect(r.totalTax).toBe(0);
    expect(r.lines[0].tax).toBe(0);
    expect(r.byRate).toEqual([]);
  });

  it("exclusive: adds tax on top of the net amount", () => {
    const r = computeTax({
      lines: [{ amount: 100, rate: 18, label: "GST 18%" }],
      pricesIncludeTax: false,
    });
    expect(r.totalTax).toBe(18);
    expect(r.lines[0].taxableValue).toBe(100);
    expect(r.lines[0].tax).toBe(18);
    expect(r.byRate).toEqual([
      { rate: 18, label: "GST 18%", taxableValue: 100, tax: 18 },
    ]);
  });

  it("inclusive: carves tax out of the gross amount", () => {
    const r = computeTax({
      lines: [{ amount: 118, rate: 18, label: "GST 18%" }],
      pricesIncludeTax: true,
    });
    expect(r.totalTax).toBe(18);
    expect(r.lines[0].taxableValue).toBe(100);
    expect(r.lines[0].tax).toBe(18);
    expect(r.inclusive).toBe(true);
  });

  it("groups multiple rates into byRate buckets", () => {
    const r = computeTax({
      lines: [
        { amount: 100, rate: 18, label: "GST 18%" },
        { amount: 200, rate: 5, label: "GST 5%" },
        { amount: 50, rate: 18, label: "GST 18%" },
      ],
      pricesIncludeTax: false,
    });
    expect(r.totalTax).toBe(round2(27 + 10)); // (150*18%)+(200*5%) = 27 + 10
    expect(r.byRate).toEqual([
      { rate: 5, label: "GST 5%", taxableValue: 200, tax: 10 },
      { rate: 18, label: "GST 18%", taxableValue: 150, tax: 27 },
    ]);
  });

  it("allocates the order discount proportionally before taxing", () => {
    const r = computeTax({
      lines: [
        { amount: 100, rate: 18, label: "GST 18%" },
        { amount: 100, rate: 18, label: "GST 18%" },
      ],
      discount: 40,
      pricesIncludeTax: false,
    });
    // Each line discounted to 80, tax 14.4, total 28.8
    expect(r.lines[0].discountedAmount).toBe(80);
    expect(r.lines[1].discountedAmount).toBe(80);
    expect(r.totalTax).toBe(28.8);
    expect(r.byRate[0]).toEqual({
      rate: 18,
      label: "GST 18%",
      taxableValue: 160,
      tax: 28.8,
    });
  });

  it("caps discount at the total and guards empty / zero", () => {
    expect(computeTax({ lines: [] }).totalTax).toBe(0);
    const r = computeTax({
      lines: [{ amount: 100, rate: 18 }],
      discount: 999,
      pricesIncludeTax: false,
    });
    // Discount capped at 100 → nothing taxable
    expect(r.lines[0].discountedAmount).toBe(0);
    expect(r.totalTax).toBe(0);
  });

  it("treats a zero-rate line as untaxed but keeps it in lines", () => {
    const r = computeTax({
      lines: [{ amount: 100, rate: 0, label: "Exempt" }],
      pricesIncludeTax: false,
    });
    expect(r.totalTax).toBe(0);
    expect(r.lines[0].taxableValue).toBe(100);
    expect(r.byRate).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-line discounts (offers, `docs/offers-plan.md` §8).
// ---------------------------------------------------------------------------

describe("computeTax — per-line discount", () => {
  it("★ taxes a scoped discount against the RIGHT line", () => {
    // The §8 example: a ₹1,000 shirt at 18% beside a ₹1,000 book at 5%, with
    // ₹200 off the shirt only. Spreading it ₹100/₹100 understates the shirt's
    // 18% base and overstates the book's 5% one — a misstated GST invoice with
    // nothing reporting an error.
    const scoped = computeTax({
      lines: [
        { amount: 1000, rate: 18, discount: 200 },
        { amount: 1000, rate: 5 },
      ],
    });
    expect(scoped.lines[0].discountedAmount).toBe(800);
    expect(scoped.lines[1].discountedAmount).toBe(1000);
    expect(scoped.lines[0].tax).toBe(144); // 18% of 800
    expect(scoped.lines[1].tax).toBe(50); // 5% of 1000
    expect(scoped.totalTax).toBe(194);

    // What the order-level path would have produced — kept here so the
    // difference is visible rather than argued.
    const spread = computeTax({
      lines: [
        { amount: 1000, rate: 18 },
        { amount: 1000, rate: 5 },
      ],
      discount: 200,
    });
    expect(spread.totalTax).toBe(207); // 18% of 900 + 5% of 900
    expect(spread.totalTax).not.toBe(scoped.totalTax);
  });

  it("★ is byte-identical to the old behaviour when no line carries a discount", () => {
    const withField = computeTax({
      lines: [
        { amount: 500, rate: 12, discount: 0 },
        { amount: 300, rate: 5, discount: 0 },
      ],
      discount: 80,
    });
    const without = computeTax({
      lines: [
        { amount: 500, rate: 12 },
        { amount: 300, rate: 5 },
      ],
      discount: 80,
    });
    expect(withField).toEqual(without);
  });

  it("composes with an order-level discount, allocating over what is left", () => {
    // ₹100 off line A, then ₹90 off the order across the remaining ₹900+₹0.
    const r = computeTax({
      lines: [
        { amount: 600, rate: 10, discount: 100 },
        { amount: 400, rate: 10 },
      ],
      discount: 90,
    });
    // Remaining base is 500 + 400 = 900; the order discount splits 50/40.
    expect(r.lines[0].discountedAmount).toBe(450);
    expect(r.lines[1].discountedAmount).toBe(360);
  });

  it("clamps a line discount to that line's own value", () => {
    const r = computeTax({
      lines: [{ amount: 100, rate: 10, discount: 9999 }],
    });
    expect(r.lines[0].discountedAmount).toBe(0);
    expect(r.lines[0].lineDiscount).toBe(100);
    expect(r.totalTax).toBe(0);
  });

  it("caps the order discount at what remains after line discounts", () => {
    const r = computeTax({
      lines: [{ amount: 100, rate: 0, discount: 100 }],
      discount: 500,
    });
    expect(r.lines[0].discountedAmount).toBe(0);
  });

  it("carves inclusive tax out of the post-discount amount", () => {
    const r = computeTax({
      lines: [{ amount: 1180, rate: 18, discount: 180 }],
      pricesIncludeTax: true,
    });
    expect(r.lines[0].discountedAmount).toBe(1000);
    // 1000 × 18 / 118
    expect(r.lines[0].tax).toBe(152.54);
    expect(r.lines[0].taxableValue).toBe(847.46);
  });

  it("ignores a non-finite or negative line discount", () => {
    const r = computeTax({
      lines: [
        { amount: 100, rate: 0, discount: Number.NaN },
        { amount: 100, rate: 0, discount: -50 },
      ],
    });
    expect(r.lines[0].lineDiscount).toBe(0);
    expect(r.lines[1].lineDiscount).toBe(0);
  });
});
