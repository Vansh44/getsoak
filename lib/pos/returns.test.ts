import { describe, it, expect } from "vitest";
import {
  fullReturnRequest,
  refundBreakdown,
  remainingQty,
  type ReturnableLine,
} from "./returns";

// A sale of 2 × ₹100 and 1 × ₹50, no discounts, 5% tax.
const plain: ReturnableLine[] = [
  { id: "a", quantity: 2, lineTotal: 200, taxAmount: 10 },
  { id: "b", quantity: 1, lineTotal: 50, taxAmount: 2.5 },
];

describe("remainingQty", () => {
  it("counts what's left after earlier returns", () => {
    expect(remainingQty({ ...plain[0], alreadyReturned: 1 })).toBe(1);
  });

  it("never goes negative, however bad the stored data", () => {
    expect(remainingQty({ ...plain[0], alreadyReturned: 99 })).toBe(0);
    expect(remainingQty({ ...plain[0], quantity: -3 })).toBe(0);
  });
});

describe("refundBreakdown — no discount", () => {
  it("refunds a whole line with its tax", () => {
    const r = refundBreakdown({
      lines: plain,
      request: [{ id: "a", quantity: 2 }],
    });
    expect(r.amount).toBe(200);
    expect(r.tax).toBe(10);
    expect(r.total).toBe(210);
  });

  it("splits a partial quantity proportionally", () => {
    const r = refundBreakdown({
      lines: plain,
      request: [{ id: "a", quantity: 1 }],
    });
    expect(r.total).toBe(105);
  });

  it("★ a full return equals what the sale charged", () => {
    // subtotal 250 + tax 12.50 = 262.50
    const r = refundBreakdown({
      lines: plain,
      request: fullReturnRequest(plain),
    });
    expect(r.total).toBe(262.5);
  });
});

describe("refundBreakdown — with an order-level discount", () => {
  // Same goods, ₹25 off the order. Tax was computed on the discounted base,
  // so taxAmount is already reduced: (200-20)*5% = 9, (50-5)*5% = 2.25.
  const discounted: ReturnableLine[] = [
    { id: "a", quantity: 2, lineTotal: 200, taxAmount: 9 },
    { id: "b", quantity: 1, lineTotal: 50, taxAmount: 2.25 },
  ];

  it("★ subtracts the line's share of the order discount — refunding total+tax would hand it back twice", () => {
    const r = refundBreakdown({
      lines: discounted,
      orderDiscount: 25,
      request: [{ id: "a", quantity: 2 }],
    });
    // 200 − 20 (its 80% share of ₹25) = 180, plus ₹9 tax.
    expect(r.amount).toBe(180);
    expect(r.total).toBe(189);
  });

  it("★ a full return still equals the sale total exactly", () => {
    // charged: 250 − 25 + 11.25 = 236.25
    const r = refundBreakdown({
      lines: discounted,
      orderDiscount: 25,
      request: fullReturnRequest(discounted),
    });
    expect(r.total).toBe(236.25);
  });

  it("★ allocates the last paise so the parts sum to the whole", () => {
    // ₹10 across three equal lines is 333.33p each — one paise must go
    // somewhere, or a full return comes up a paise short.
    const three: ReturnableLine[] = [
      { id: "a", quantity: 1, lineTotal: 100, taxAmount: 0 },
      { id: "b", quantity: 1, lineTotal: 100, taxAmount: 0 },
      { id: "c", quantity: 1, lineTotal: 100, taxAmount: 0 },
    ];
    const r = refundBreakdown({
      lines: three,
      orderDiscount: 10,
      request: fullReturnRequest(three),
    });
    expect(r.total).toBe(290);
  });
});

describe("refundBreakdown — guards", () => {
  it("clamps a request for more than remains", () => {
    const r = refundBreakdown({
      lines: [{ ...plain[0], alreadyReturned: 1 }],
      request: [{ id: "a", quantity: 5 }],
    });
    expect(r.lines[0].quantity).toBe(1);
    expect(r.total).toBe(105);
  });

  it("ignores a line that isn't on the sale", () => {
    const r = refundBreakdown({
      lines: plain,
      request: [{ id: "nope", quantity: 1 }],
    });
    expect(r.lines).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("ignores a zero or negative quantity", () => {
    const r = refundBreakdown({
      lines: plain,
      request: [
        { id: "a", quantity: 0 },
        { id: "b", quantity: -2 },
      ],
    });
    expect(r.total).toBe(0);
  });

  it("★ a discount larger than the goods can't produce a negative refund", () => {
    const r = refundBreakdown({
      lines: plain,
      orderDiscount: 9999,
      request: fullReturnRequest(plain),
    });
    expect(r.amount).toBe(0);
    expect(r.total).toBeGreaterThanOrEqual(0);
  });

  it("leaves a fully-returned line out of a full request", () => {
    const done = plain.map((l) => ({ ...l, alreadyReturned: l.quantity }));
    expect(fullReturnRequest(done)).toEqual([]);
  });
});

describe("★ duplicate request entries can't multiply a refund", () => {
  const oneUnit = [
    { id: "a", quantity: 1, lineTotal: 500, taxAmount: 0, alreadyReturned: 0 },
  ];

  it("sums duplicates for the SAME line before clamping, not after", () => {
    // The request array is client-controlled. Clamping each entry against
    // `remainingQty` independently let three entries each pass the cap on a
    // one-unit line and return 3× the money in a single call — no race, no
    // second request. Both the till's cash refund and the shopper's request
    // form funnel through here, so this is the one place it can be stopped.
    const attack = refundBreakdown({
      lines: oneUnit,
      request: [
        { id: "a", quantity: 1 },
        { id: "a", quantity: 1 },
        { id: "a", quantity: 1 },
      ],
    });
    expect(attack.total).toBe(500);
    expect(attack.lines).toHaveLength(1);
    expect(attack.lines[0]!.quantity).toBe(1);
  });

  it("still honours a legitimate split request up to what remains", () => {
    const three = [
      {
        id: "a",
        quantity: 3,
        lineTotal: 300,
        taxAmount: 0,
        alreadyReturned: 0,
      },
    ];
    const r = refundBreakdown({
      lines: three,
      request: [
        { id: "a", quantity: 1 },
        { id: "a", quantity: 1 },
      ],
    });
    expect(r.lines[0]!.quantity).toBe(2);
    expect(r.total).toBe(200);
  });

  it("clamps the SUM against what is left, not each entry", () => {
    const partly = [
      {
        id: "a",
        quantity: 3,
        lineTotal: 300,
        taxAmount: 0,
        alreadyReturned: 2,
      },
    ];
    const r = refundBreakdown({
      lines: partly,
      request: [
        { id: "a", quantity: 1 },
        { id: "a", quantity: 5 },
      ],
    });
    expect(r.lines[0]!.quantity).toBe(1); // one unit left, not six
    expect(r.total).toBe(100);
  });
});

describe("★ a line with no quantity", () => {
  it.each([0, undefined, null, Number.NaN])(
    "remainingQty reports nothing returnable for a quantity of %s",
    (quantity) => {
      // A corrupt or half-written order_items row must read as "nothing to
      // send back", never as an unbounded one.
      expect(
        remainingQty({
          id: "a",
          quantity: quantity as unknown as number,
          lineTotal: 100,
          taxAmount: 0,
        }),
      ).toBe(0);
    },
  );

  it("★ is what stops such a line reaching the money arithmetic at all", () => {
    // `refundBreakdown` skips any line whose remaining quantity is zero, so a
    // quantity-less line can never be priced. That is also why the `Math.max(1,
    // …)` divisor further down is unreachable in practice — by the time it
    // runs, remainingQty has already proved the quantity is at least 1.
    const r = refundBreakdown({
      lines: [{ id: "a", quantity: 0, lineTotal: 100, taxAmount: 10 }],
      request: [{ id: "a", quantity: 5 }],
    });
    expect(r.lines).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("prices the healthy lines and drops the broken one", () => {
    const r = refundBreakdown({
      lines: [
        { id: "a", quantity: 0, lineTotal: 100, taxAmount: 10 },
        { id: "b", quantity: 2, lineTotal: 200, taxAmount: 20 },
      ],
      request: [
        { id: "a", quantity: 1 },
        { id: "b", quantity: 2 },
      ],
    });
    expect(r.lines.map((l) => l.id)).toEqual(["b"]);
    expect(r.total).toBe(220);
  });
});

// ---------------------------------------------------------------------------
// Offer-allocated line discounts (`docs/offers-plan.md` §8).
// ---------------------------------------------------------------------------

describe("refundBreakdown — offer discounts", () => {
  it("★ a Buy-1-Get-1 free line refunds NOTHING, not full price", () => {
    // Two ₹1,000 shirts, the second free via an offer allocated entirely to it.
    // Returning only the free one must hand back ₹0 — otherwise the customer
    // keeps a free shirt and takes ₹1,000.
    const lines = [
      { id: "paid", quantity: 1, lineTotal: 1000, taxAmount: 0 },
      {
        id: "free",
        quantity: 1,
        lineTotal: 1000,
        taxAmount: 0,
        offerDiscount: 1000,
      },
    ];
    const r = refundBreakdown({
      lines,
      request: [{ id: "free", quantity: 1 }],
    });
    expect(r.total).toBe(0);
  });

  it("refunds the paid line in full when the other was the free one", () => {
    const lines = [
      { id: "paid", quantity: 1, lineTotal: 1000, taxAmount: 0 },
      {
        id: "free",
        quantity: 1,
        lineTotal: 1000,
        taxAmount: 0,
        offerDiscount: 1000,
      },
    ];
    const r = refundBreakdown({
      lines,
      request: [{ id: "paid", quantity: 1 }],
    });
    expect(r.total).toBe(1000);
  });

  it("★ does NOT spread a scoped offer across untouched lines", () => {
    // ₹200 off the shirt only. Returning the book must refund its full ₹1,000 —
    // proportional re-allocation would refund ₹900 for goods paid at ₹1,000.
    const lines = [
      {
        id: "shirt",
        quantity: 1,
        lineTotal: 1000,
        taxAmount: 0,
        offerDiscount: 200,
      },
      { id: "book", quantity: 1, lineTotal: 1000, taxAmount: 0 },
    ];
    const book = refundBreakdown({
      lines,
      request: [{ id: "book", quantity: 1 }],
    });
    expect(book.total).toBe(1000);

    const shirt = refundBreakdown({
      lines,
      request: [{ id: "shirt", quantity: 1 }],
    });
    expect(shirt.total).toBe(800);
  });

  it("splits an offer share across the units of one line", () => {
    // 3 units at ₹100, ₹30 off the line → ₹10 off each unit.
    const lines = [
      { id: "l", quantity: 3, lineTotal: 300, taxAmount: 0, offerDiscount: 30 },
    ];
    const r = refundBreakdown({ lines, request: [{ id: "l", quantity: 1 }] });
    expect(r.total).toBe(90);
  });

  it("composes an offer share with an order-level remainder", () => {
    // ₹100 off line A by an offer, then ₹90 of manual order discount across
    // the remaining ₹500 + ₹400.
    const lines = [
      {
        id: "a",
        quantity: 1,
        lineTotal: 600,
        taxAmount: 0,
        offerDiscount: 100,
      },
      { id: "b", quantity: 1, lineTotal: 400, taxAmount: 0 },
    ];
    const r = refundBreakdown({
      lines,
      orderDiscount: 90,
      request: [
        { id: "a", quantity: 1 },
        { id: "b", quantity: 1 },
      ],
    });
    expect(r.total).toBe(810); // 1000 − 100 − 90
  });

  it("★ a full return always hands back exactly what was paid", () => {
    const lines = [
      {
        id: "a",
        quantity: 2,
        lineTotal: 333,
        taxAmount: 33.3,
        offerDiscount: 77,
      },
      {
        id: "b",
        quantity: 1,
        lineTotal: 667,
        taxAmount: 66.7,
        offerDiscount: 13,
      },
    ];
    const r = refundBreakdown({
      lines,
      orderDiscount: 41,
      request: [
        { id: "a", quantity: 2 },
        { id: "b", quantity: 1 },
      ],
    });
    // Goods paid = 333 + 667 − 77 − 13 − 41 = 869, plus the stored tax.
    expect(r.amount).toBeCloseTo(869, 2);
    expect(r.tax).toBeCloseTo(100, 2);
  });

  it("clamps an offer share to the line's own value", () => {
    const lines = [
      {
        id: "l",
        quantity: 1,
        lineTotal: 100,
        taxAmount: 0,
        offerDiscount: 9999,
      },
    ];
    const r = refundBreakdown({ lines, request: [{ id: "l", quantity: 1 }] });
    expect(r.total).toBe(0);
  });

  it("is unchanged for a sale with no offers", () => {
    const lines = [{ id: "l", quantity: 1, lineTotal: 500, taxAmount: 25 }];
    const withField = refundBreakdown({
      lines: [{ ...lines[0], offerDiscount: 0 }],
      request: [{ id: "l", quantity: 1 }],
    });
    const without = refundBreakdown({
      lines,
      request: [{ id: "l", quantity: 1 }],
    });
    expect(withField).toEqual(without);
  });
});
