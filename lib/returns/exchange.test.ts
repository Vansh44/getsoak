import { describe, it, expect } from "vitest";
import { exchangeSettlement, isExchange } from "./exchange";

describe("exchangeSettlement", () => {
  it("★ an even swap settles to nothing — the 80% case", () => {
    // Medium for large, same price. No money moves in either direction, which
    // is exactly why this is the case worth making effortless.
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 500 });
    expect(s.even).toBe(true);
    expect(s.storeOwes).toBe(0);
    expect(s.customerOwes).toBe(0);
    expect(s.allowed).toBe(true);
  });

  it("the store owes the difference on a cheaper replacement", () => {
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 350 });
    expect(s.storeOwes).toBe(150);
    expect(s.customerOwes).toBe(0);
    expect(s.even).toBe(false);
    expect(s.allowed).toBe(true);
  });

  it("★ REFUSES a dearer replacement, with a sentence that says what to do", () => {
    // Collecting the difference is a payment flow that doesn't exist outside
    // checkout. Half-building it leaves replacement orders unpaid forever.
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 800 });
    expect(s.customerOwes).toBe(300);
    expect(s.allowed).toBe(false);
    expect(s.blockedCopy).toContain("300.00");
    expect(s.blockedCopy).toContain("new order");
  });

  it("★ still COMPUTES what's owed even when it refuses", () => {
    // The day a payment-link flow exists, this is the number to charge — the
    // arithmetic is the boundary, not a flag that hides it.
    expect(
      exchangeSettlement({ returnValue: 100, replacementValue: 250 })
        .customerOwes,
    ).toBe(150);
  });

  it("works in paise, so a rupee of float drift can't flip 'even'", () => {
    const s = exchangeSettlement({
      returnValue: 0.1 + 0.2, // 0.30000000000000004
      replacementValue: 0.3,
    });
    expect(s.even).toBe(true);
    expect(s.allowed).toBe(true);
  });

  it("treats a free replacement as the store owing everything", () => {
    const s = exchangeSettlement({ returnValue: 500, replacementValue: 0 });
    expect(s.storeOwes).toBe(500);
    expect(s.allowed).toBe(true);
  });

  it("never produces a negative anything from junk input", () => {
    const s = exchangeSettlement({
      returnValue: -100,
      replacementValue: Number.NaN,
    });
    expect(s.returnValue).toBe(0);
    expect(s.replacementValue).toBe(0);
    expect(s.storeOwes).toBe(0);
    expect(s.customerOwes).toBe(0);
  });
});

describe("isExchange", () => {
  it("is true when any line asks for a swap", () => {
    expect(
      isExchange([
        { orderItemId: "a", quantity: 1 },
        { orderItemId: "b", quantity: 1, exchangeVariantId: "v2" },
      ]),
    ).toBe(true);
  });

  it("is false for a plain refund request", () => {
    expect(
      isExchange([
        { orderItemId: "a", quantity: 1 },
        { orderItemId: "b", quantity: 2, exchangeVariantId: null },
      ]),
    ).toBe(false);
  });

  it("counts a product-level swap too", () => {
    expect(
      isExchange([{ orderItemId: "a", quantity: 1, exchangeProductId: "p9" }]),
    ).toBe(true);
  });
});
