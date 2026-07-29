import { describe, it, expect } from "vitest";
import {
  formatMoney,
  formatVariable,
  summariseItems,
  HIDDEN_VARIABLES,
} from "./format";

// These are the rules that decide whether a customer's order confirmation
// reads like a receipt or like a database dump. It used to be the latter:
// "Total 281.4 / Currency INR / Payment method cod".
describe("formatMoney", () => {
  it("shows the symbol and two decimals", () => {
    expect(formatMoney(281.4)).toBe("₹281.40");
    expect(formatMoney(1240)).toBe("₹1,240.00");
  });

  it("groups rupees the Indian way", () => {
    // ₹1,24,000 — not ₹124,000. Getting this wrong reads as sloppy to exactly
    // the people it's wrong for.
    expect(formatMoney(124000)).toBe("₹1,24,000.00");
  });

  it("honours another currency", () => {
    expect(formatMoney(99.5, "USD")).toContain("99.50");
  });

  it("returns nothing for a non-number rather than 'NaN'", () => {
    expect(formatMoney(Number.NaN)).toBe("");
  });
});

describe("formatVariable", () => {
  it("formats money by variable NAME, not by looking like a number", () => {
    // `items` and `total` are both numbers; only one is a price.
    expect(formatVariable("total", 281.4)).toBe("₹281.40");
    expect(formatVariable("items", 2)).toBe("2");
  });

  it("turns payment enums into something a shopper would say", () => {
    expect(formatVariable("payment_method", "cod")).toBe("Cash on delivery");
    expect(formatVariable("payment_method", "razorpay")).toBe("Paid online");
    expect(formatVariable("payment_method", "upi")).toBe("UPI");
  });

  it("humanises an unknown enum instead of printing it raw", () => {
    expect(formatVariable("payment_method", "net_banking")).toBe("Net banking");
    expect(formatVariable("status", "awaiting_pickup")).toBe("Awaiting pickup");
  });

  it("drops the machine detail from a timestamp", () => {
    const out = formatVariable("date", "2026-07-28T00:20:46.000Z");
    expect(out).toContain("July");
    expect(out).not.toContain(":46"); // no seconds
  });

  it("leaves a link untouched — formatting would corrupt a URL", () => {
    expect(formatVariable("link", "/orders/abc?x=1")).toBe("/orders/abc?x=1");
  });

  it("counts days in words", () => {
    expect(formatVariable("days_left", 7)).toBe("7 days");
    expect(formatVariable("days_left", 1)).toBe("1 day");
  });

  it("passes through anything it has no opinion about", () => {
    expect(formatVariable("subject_label", "ORD100110279")).toBe(
      "ORD100110279",
    );
  });

  it("renders nothing for a missing value rather than 'undefined'", () => {
    expect(formatVariable("total", null)).toBe("");
    expect(formatVariable("total", undefined)).toBe("");
  });

  // Currency rides on every amount, so a row of its own is the email saying it
  // twice — which is what made the old one read like a form.
  it("hides currency, because the total already carries it", () => {
    expect(HIDDEN_VARIABLES.has("currency")).toBe(true);
  });
});

describe("summariseItems", () => {
  it("names what was bought, not just how many", () => {
    expect(
      summariseItems([
        { name: "Amul Taaza Toned Milk", variantName: "1 L", quantity: 1 },
        { name: "Tata Salt", variantName: null, quantity: 2 },
      ]),
    ).toBe("3 items · Amul Taaza Toned Milk (1 L), Tata Salt × 2");
  });

  it("counts UNITS, not lines", () => {
    // Two lines but four things in the box.
    expect(
      summariseItems([
        { name: "A", quantity: 3 },
        { name: "B", quantity: 1 },
      ]),
    ).toBe("4 items · A × 3, B");
  });

  it("says 'item' for a single one", () => {
    expect(summariseItems([{ name: "Tata Salt", quantity: 1 }])).toBe(
      "1 item · Tata Salt",
    );
  });

  // A forty-line order must not turn one summary row into a wall; the button
  // goes to the order page, which has the full list.
  it("caps the names and counts the rest", () => {
    const out = summariseItems(
      ["A", "B", "C", "D", "E"].map((name) => ({ name, quantity: 1 })),
    );
    expect(out).toBe("5 items · A, B, C +2 more");
  });

  it("returns nothing for an empty order", () => {
    expect(summariseItems([])).toBe("");
  });
});

describe("hours_left", () => {
  it("reads as a duration, not a bare number", () => {
    expect(formatVariable("hours_left", 18)).toBe("18 hours");
    expect(formatVariable("hours_left", 1)).toBe("1 hour");
  });
});
