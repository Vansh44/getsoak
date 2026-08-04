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
