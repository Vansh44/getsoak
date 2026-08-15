import { describe, it, expect } from "vitest";
import {
  MAX_LABEL_LENGTH,
  MAX_PARKED_LINES,
  parkedAge,
  parkedSaleLabel,
  validateParkInput,
} from "./park";

const line = { productId: "p1", variantId: null, quantity: 2 };

describe("validateParkInput", () => {
  it("keeps the choices and normalises the rest", () => {
    const r = validateParkInput({
      label: "  Blue jacket  ",
      lines: [line],
      orderDiscount: 50,
      customerId: " cust-1 ",
      customerGstin: " 22aaaaa0000a1z5 ",
      note: " ring back ",
    });
    expect(r).toEqual({
      ok: true,
      label: "Blue jacket",
      lines: [{ productId: "p1", variantId: null, quantity: 2 }],
      orderDiscount: 50,
      customerId: "cust-1",
      customerGstin: "22AAAAA0000A1Z5",
      note: "ring back",
    });
  });

  // Parking an empty cart leaves a row that resumes into the state the cashier
  // is already in.
  it("refuses an empty cart", () => {
    const r = validateParkInput({ lines: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/add something/i);
  });

  it("refuses a cart with more lines than a sale could carry", () => {
    const r = validateParkInput({
      lines: Array.from({ length: MAX_PARKED_LINES + 1 }, () => line),
    });
    expect(r.ok).toBe(false);
  });

  it.each([[0], [-1], [1.5], [NaN]])("refuses the quantity %s", (quantity) => {
    const r = validateParkInput({ lines: [{ ...line, quantity }] });
    expect(r.ok).toBe(false);
  });

  it("refuses a line with no product", () => {
    expect(
      validateParkInput({ lines: [{ ...line, productId: "  " }] }).ok,
    ).toBe(false);
  });

  // ★ PRICES ARE NOT STORED. A held cart can sit for hours; keeping a price
  // would let a resumed sale charge yesterday's, which is the same reason
  // placePosSale ignores client prices.
  it("drops anything that isn't a choice", () => {
    const r = validateParkInput({
      lines: [{ ...line, unitPrice: 999, name: "Milk" } as never],
    });
    expect(r.ok && r.lines[0]).toEqual({
      productId: "p1",
      variantId: null,
      quantity: 2,
    });
  });

  it("keeps a per-line markdown but drops a meaningless one", () => {
    const withDiscount = validateParkInput({
      lines: [{ ...line, lineDiscount: 30 }],
    });
    expect(withDiscount.ok && withDiscount.lines[0].lineDiscount).toBe(30);

    for (const bad of [0, -5, NaN]) {
      const r = validateParkInput({ lines: [{ ...line, lineDiscount: bad }] });
      expect(r.ok && "lineDiscount" in r.lines[0]).toBe(false);
    }
  });

  it("treats a negative or unreadable order discount as none", () => {
    for (const bad of [-10, NaN, undefined]) {
      const r = validateParkInput({ lines: [line], orderDiscount: bad });
      expect(r.ok && r.orderDiscount).toBe(0);
    }
  });

  it("caps a pasted label rather than refusing it", () => {
    const r = validateParkInput({ lines: [line], label: "x".repeat(500) });
    expect(r.ok && r.label?.length).toBe(MAX_LABEL_LENGTH);
  });

  it("treats blank optional fields as absent", () => {
    const r = validateParkInput({
      lines: [line],
      label: "   ",
      customerId: "",
      customerGstin: "  ",
      note: " ",
    });
    expect(r.ok && r.label).toBeNull();
    expect(r.ok && r.customerId).toBeNull();
    expect(r.ok && r.customerGstin).toBeNull();
    expect(r.ok && r.note).toBeNull();
  });

  it("survives a non-array lines value", () => {
    expect(validateParkInput({ lines: null as never }).ok).toBe(false);
  });
});

// ★ NEVER "Untitled". The list is scanned under pressure with a customer
// waiting; a column of identical placeholders is the same as no list.
describe("parkedSaleLabel", () => {
  it("uses the cashier's own label when there is one", () => {
    expect(parkedSaleLabel({ label: "Blue jacket", items: 3 })).toBe(
      "Blue jacket",
    );
  });

  it("falls back to what it contains and who held it", () => {
    expect(
      parkedSaleLabel({ label: null, items: 3, parkedByName: "Priya" }),
    ).toBe("3 items · Priya");
  });

  it("falls back to the size alone when nobody is named", () => {
    expect(parkedSaleLabel({ label: null, items: 1 })).toBe("1 item");
  });
});

describe("parkedAge", () => {
  const now = new Date("2026-08-16T12:00:00Z");
  it.each([
    ["2026-08-16T11:59:40Z", "just now"],
    ["2026-08-16T11:58:00Z", "2 min ago"],
    ["2026-08-16T10:00:00Z", "2 hr ago"],
    ["2026-08-15T12:00:00Z", "1 day ago"],
    ["2026-08-13T12:00:00Z", "3 days ago"],
  ])("renders %s as %s", (at, expected) => {
    expect(parkedAge(at, now)).toBe(expected);
  });

  // A clock skew between till and server must not render "-3 min ago".
  it("never goes negative", () => {
    expect(parkedAge("2026-08-16T12:05:00Z", now)).toBe("just now");
  });

  it("returns nothing for an unreadable date", () => {
    expect(parkedAge("not-a-date", now)).toBe("");
  });
});
