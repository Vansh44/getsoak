import { describe, it, expect } from "vitest";
import { posTotals, coversTotal, changeDue, paise } from "./totals";

describe("posTotals", () => {
  // The 2026-07-27 register bug, exactly as it was rung up: 2 × ₹119 on a 5%
  // tax class. The screen quoted ₹238 (pre-tax), the sale charged ₹249.90, and
  // ₹300 cash came back as ₹50.10 change instead of the ₹62 the customer was
  // promised. One helper now produces the quote AND the charge.
  it("quotes the tax-inclusive total a 5% class actually charges", () => {
    const t = posTotals({
      lines: [{ gross: 238, lineDiscount: 0, rate: 5 }],
      pricesIncludeTax: false,
      taxEnabled: true,
    });
    expect(t.subtotal).toBe(238);
    expect(t.tax).toBe(11.9);
    expect(t.total).toBe(249.9);
    expect(changeDue(300, t.total)).toBe(50.1);
    // …and tendering exactly what the screen says must be accepted.
    expect(coversTotal(t.total, t.total)).toBe(true);
  });

  it("adds nothing when tax is disabled", () => {
    const t = posTotals({
      lines: [{ gross: 238, lineDiscount: 0, rate: 5 }],
      taxEnabled: false,
    });
    expect(t.tax).toBe(0);
    expect(t.total).toBe(238);
  });

  // Inclusive pricing carves the tax out for the invoice; charging it again
  // would double-tax the customer.
  it("leaves the total alone when prices already include tax", () => {
    const t = posTotals({
      lines: [{ gross: 105, lineDiscount: 0, rate: 5 }],
      pricesIncludeTax: true,
      taxEnabled: true,
    });
    expect(t.total).toBe(105);
    expect(t.tax).toBe(5);
  });

  it("taxes the discounted amount, not the list price", () => {
    const t = posTotals({
      lines: [{ gross: 200, lineDiscount: 0, rate: 10 }],
      requestedOrderDiscount: 100,
      taxEnabled: true,
    });
    expect(t.tax).toBe(10); // 10% of 100, not of 200
    expect(t.total).toBe(110);
  });

  it("applies line markdowns before the order discount", () => {
    const t = posTotals({
      lines: [
        { gross: 200, lineDiscount: 30, rate: 0 },
        { gross: 100, lineDiscount: 0, rate: 0 },
      ],
      requestedOrderDiscount: 20,
    });
    expect(t.subtotal).toBe(300);
    expect(t.lineDiscountTotal).toBe(30);
    expect(t.orderDiscount).toBe(20);
    expect(t.total).toBe(250);
  });

  // The cap is HERE so the screen and the server cap identically — a cashier
  // typing a giant discount must not produce a negative bill on either.
  it("caps the order discount at what's left after line markdowns", () => {
    const t = posTotals({
      lines: [{ gross: 100, lineDiscount: 40, rate: 0 }],
      requestedOrderDiscount: 5000,
    });
    expect(t.orderDiscount).toBe(60);
    expect(t.total).toBe(0);
  });

  it("ignores a line markdown larger than the line itself", () => {
    const t = posTotals({ lines: [{ gross: 50, lineDiscount: 900, rate: 0 }] });
    expect(t.lineDiscountTotal).toBe(50);
    expect(t.total).toBe(0);
  });

  it("survives an empty cart and non-finite input", () => {
    expect(posTotals({ lines: [] }).total).toBe(0);
    const t = posTotals({
      lines: [{ gross: NaN, lineDiscount: NaN, rate: NaN }],
      requestedOrderDiscount: NaN,
    });
    expect(t.total).toBe(0);
    expect(t.tax).toBe(0);
  });

  it("returns per-line tax in input order for the invoice snapshot", () => {
    const t = posTotals({
      lines: [
        { gross: 100, lineDiscount: 0, rate: 5 },
        { gross: 200, lineDiscount: 0, rate: 12 },
      ],
      taxEnabled: true,
    });
    expect(t.taxLines).toHaveLength(2);
    expect(t.taxLines[0].tax).toBe(5);
    expect(t.taxLines[1].tax).toBe(24);
  });
});

describe("money comparison", () => {
  // Rupee floats compare wrong; paise integers don't. 0.1 + 0.2 !== 0.3 would
  // otherwise refuse a payment that exactly covers the bill.
  it("accepts a payment that exactly covers a float-awkward total", () => {
    expect(coversTotal(0.1 + 0.2, 0.3)).toBe(true);
    expect(changeDue(0.1 + 0.2, 0.3)).toBe(0);
  });

  it("refuses a payment that is genuinely short", () => {
    expect(coversTotal(249.89, 249.9)).toBe(false);
  });

  it("never reports negative change", () => {
    expect(changeDue(100, 250)).toBe(0);
  });

  it("converts to paise without float drift", () => {
    expect(paise(249.9)).toBe(24990);
    expect(paise(0.07)).toBe(7);
  });
});
