import { describe, it, expect } from "vitest";
import { renderOrderSummary } from "./line-items";

const items = [
  { name: "Amul Taaza Toned Milk", variant: "1 L", quantity: 1, total: 68 },
  { name: "Tata Salt", variant: null, quantity: 2, total: 50 },
];

describe("renderOrderSummary", () => {
  it("lists what was bought, with prices", () => {
    const html = renderOrderSummary({ items, currency: "INR", total: 118 });

    expect(html).toContain("Amul Taaza Toned Milk");
    expect(html).toContain("1 L");
    expect(html).toContain("₹68.00");
    expect(html).toContain("Tata Salt");
  });

  it("shows a quantity only when there's more than one", () => {
    const html = renderOrderSummary({ items, currency: "INR" });
    expect(html).toContain("Qty 2"); // Tata Salt
    expect(html).not.toContain("Qty 1"); // noise on a single unit
  });

  it("renders the totals ladder", () => {
    const html = renderOrderSummary({
      items,
      currency: "INR",
      subtotal: 118,
      tax: 5.9,
      total: 123.9,
    });
    expect(html).toContain("Subtotal");
    expect(html).toContain("₹118.00");
    expect(html).toContain("Tax");
    expect(html).toContain("Total");
    expect(html).toContain("₹123.90");
  });

  // A discount is money coming OFF. Rendered bare it reads as another charge,
  // and the totals visibly stop adding up.
  it("shows a discount as a negative", () => {
    const html = renderOrderSummary({
      items,
      currency: "INR",
      subtotal: 118,
      discount: 20,
      total: 98,
    });
    expect(html).toContain("−₹20.00");
  });

  it("omits a line the order doesn't have", () => {
    const html = renderOrderSummary({ items, currency: "INR", total: 118 });
    expect(html).not.toContain("Shipping");
    expect(html).not.toContain("Discount");
  });

  // The block is attached to EVERY notification email; only order-shaped ones
  // carry items. An empty frame on "Blog approved" would look broken.
  it("renders nothing when there is nothing to show", () => {
    expect(renderOrderSummary(null)).toBe("");
    expect(renderOrderSummary({})).toBe("");
    expect(renderOrderSummary({ items: [] })).toBe("");
  });

  it("still renders totals for an order with no itemised lines", () => {
    expect(renderOrderSummary({ items: [], total: 500 })).toContain("₹500.00");
  });

  // Product names are merchant-authored and reach an inbox as HTML.
  it("escapes product names", () => {
    const html = renderOrderSummary({
      items: [
        {
          name: "<script>alert(1)</script>",
          variant: '"><img src=x>',
          quantity: 1,
          total: 10,
        },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("caps a huge order and says how many are hidden", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      name: `Item ${i}`,
      quantity: 1,
      total: 10,
    }));
    const html = renderOrderSummary({ items: many, total: 250 });

    expect(html).toContain("Item 19");
    expect(html).not.toContain("Item 20");
    expect(html).toContain("+5 more items");
  });

  it("defaults to INR when the currency is missing", () => {
    expect(renderOrderSummary({ items, total: 118 })).toContain("₹118.00");
  });
});
