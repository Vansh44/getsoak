import { describe, it, expect } from "vitest";
import {
  formatDate,
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
    expect(formatVariable("payment_method", "razorpay")).toBe("Online payment");
    expect(formatVariable("payment_method", "upi")).toBe("UPI");
  });

  it("★★ a METHOD label never claims the money arrived", () => {
    // `razorpay` read "Paid online" and `pos` read "Paid in store". This maps
    // payment_METHOD — how an order is to be settled, not whether it has been —
    // so a shopper who reached the gateway and paid nothing was emailed a
    // confirmation whose payment line read "Paid online". Whether money arrived
    // is payment_STATUS, which has its own vocabulary.
    for (const method of ["razorpay", "pos", "cod", "pay_at_store"]) {
      expect(formatVariable("payment_method", method)).not.toMatch(/paid/i);
    }
    // ...and the status map is where "paid" is allowed to appear.
    expect(formatVariable("payment_status", "paid")).toMatch(/paid/i);
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

describe("formatDate", () => {
  // ★ The bug this pins: an order placed on 5 August 2026 was confirmed to the
  // customer as "8 May 2026". record.ts passed a LOCALE string
  // ("5/8/2026, 9:42:46 am", en-IN D/M/Y), templateValues formatted every value
  // including that one, and V8 parses a bare M/D/Y date — so the day and month
  // swapped. Past the 12th it doesn't parse at all and the raw string reached
  // the email instead.
  it("reads an ISO timestamp, the only unambiguous input", () => {
    expect(formatDate("2026-08-05T04:12:46.000Z")).toBe(
      "5 August 2026 at 9:42 am",
    );
    expect(formatDate("2026-07-28T18:50:00.000Z")).toBe(
      "29 July 2026 at 12:20 am",
    );
  });

  // ★ Pinned timezone: without it this renders in the system zone — UTC on
  // Cloud Run — so a 3:12 pm order was confirmed as "9:42 am".
  it("renders in IST regardless of the server's timezone", () => {
    // 09:42 UTC is 15:12 IST on the same day.
    expect(formatDate("2026-08-05T09:42:00.000Z")).toBe(
      "5 August 2026 at 3:12 pm",
    );
  });

  // A date that never round-trips is better shown raw than dropped, but it must
  // not silently become a different day.
  it("returns an unparseable value untouched", () => {
    expect(formatDate("28/7/2026, 12:20:46 am")).toBe("28/7/2026, 12:20:46 am");
    expect(formatDate("")).toBe("");
  });

  it("is reached through formatVariable for date-shaped names", () => {
    expect(formatVariable("date", "2026-08-05T04:12:46.000Z")).toBe(
      "5 August 2026 at 9:42 am",
    );
    expect(formatVariable("delivered_at", "2026-08-05T04:12:46.000Z")).toBe(
      "5 August 2026 at 9:42 am",
    );
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

describe("pay_at_store", () => {
  it("reads as a method, not a database value", () => {
    expect(formatVariable("payment_method", "pay_at_store")).toBe(
      "Pay at store",
    );
  });
});
