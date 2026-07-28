import { describe, it, expect } from "vitest";
import {
  netCashFromSales,
  round2,
  shiftTotals,
  totalsByMethod,
  varianceOf,
  varianceState,
  type CashPaymentRow,
  type MovementRow,
} from "./shifts";

const cash = (
  orderId: string,
  amount: number,
  changeDue: number | null = null,
): CashPaymentRow => ({ orderId, amount, changeDue });

describe("netCashFromSales", () => {
  it("is zero with no sales", () => {
    expect(netCashFromSales([])).toBe(0);
  });

  it("takes the tendered amount less the change given", () => {
    // ₹200 handed over for a ₹118 sale: the drawer keeps ₹118.
    expect(netCashFromSales([cash("o1", 200, 82)])).toBe(118);
  });

  it("takes exact payment at face value", () => {
    expect(netCashFromSales([cash("o1", 118, 0)])).toBe(118);
    expect(netCashFromSales([cash("o1", 118, null)])).toBe(118);
  });

  it("sums across orders", () => {
    expect(netCashFromSales([cash("o1", 200, 82), cash("o2", 50, 0)])).toBe(
      168,
    );
  });

  // THE bug this function exists to prevent. placePosSale writes the SALE's
  // change onto every cash tender row, so summing change_due would deduct it
  // once per row and report the drawer short — consistently, and always
  // against whoever was on the till.
  it("subtracts change ONCE for an order split across two cash rows", () => {
    const rows = [cash("o1", 100, 30), cash("o1", 100, 30)];
    // ₹200 in, ₹30 back = ₹170. Naive summing would give ₹140.
    expect(netCashFromSales(rows)).toBe(170);
  });

  it("keeps orders independent when they share a change amount", () => {
    const rows = [cash("o1", 100, 30), cash("o2", 100, 30)];
    expect(netCashFromSales(rows)).toBe(140);
  });

  it("rounds to paise rather than accumulating float drift", () => {
    const rows = Array.from({ length: 3 }, (_, i) => cash(`o${i}`, 0.1, 0));
    expect(netCashFromSales(rows)).toBe(0.3);
  });
});

describe("shiftTotals", () => {
  const base = { openingFloat: 2000, payments: [], movements: [] };

  it("expects just the float on an untouched drawer", () => {
    expect(shiftTotals(base)).toMatchObject({
      cashSales: 0,
      expectedCash: 2000,
    });
  });

  it("adds net cash sales", () => {
    const t = shiftTotals({ ...base, payments: [cash("o1", 500, 100)] });
    expect(t.cashSales).toBe(400);
    expect(t.expectedCash).toBe(2400);
  });

  it("adds paid-ins and subtracts payouts and drops", () => {
    const movements: MovementRow[] = [
      { type: "paid_in", amount: 500 },
      { type: "payout", amount: 200 },
      { type: "drop", amount: 1000 },
    ];
    const t = shiftTotals({ ...base, movements });
    expect(t).toMatchObject({ paidIn: 500, payouts: 200, drops: 1000 });
    // 2000 + 0 + 500 − 200 − 1000
    expect(t.expectedCash).toBe(1300);
  });

  // The type carries direction, so a stray negative must not flip it — that
  // would turn a ₹500 drop into a ₹500 deposit.
  it("treats amounts as magnitudes, never as signed", () => {
    const t = shiftTotals({
      ...base,
      movements: [{ type: "drop", amount: -500 }],
    });
    expect(t.drops).toBe(500);
    expect(t.expectedCash).toBe(1500);
  });

  it("computes a full day end to end", () => {
    const t = shiftTotals({
      openingFloat: 2000,
      payments: [
        cash("o1", 500, 100),
        cash("o2", 250, 0),
        cash("o3", 1000, 55),
      ],
      movements: [
        { type: "drop", amount: 1500 },
        { type: "payout", amount: 300 },
        { type: "paid_in", amount: 100 },
      ],
    });
    // sales: 400 + 250 + 945 = 1595
    expect(t.cashSales).toBe(1595);
    // 2000 + 1595 + 100 − 300 − 1500
    expect(t.expectedCash).toBe(1895);
  });

  it("handles a missing float as zero", () => {
    expect(
      shiftTotals({ openingFloat: 0, payments: [], movements: [] })
        .expectedCash,
    ).toBe(0);
  });
});

describe("varianceOf / varianceState", () => {
  it("is negative when the drawer is short", () => {
    expect(varianceOf(1850, 1895)).toBe(-45);
    expect(varianceState(-45)).toBe("short");
  });

  it("is positive when the drawer is over", () => {
    expect(varianceOf(1920, 1895)).toBe(25);
    expect(varianceState(25)).toBe("over");
  });

  it("is balanced when it matches", () => {
    expect(varianceOf(1895, 1895)).toBe(0);
    expect(varianceState(0)).toBe("balanced");
  });

  // A drawer counted by hand is never exact to the paise; a store may choose
  // not to shout about small change.
  it("respects a tolerance in both directions", () => {
    expect(varianceState(-1, 2)).toBe("balanced");
    expect(varianceState(1, 2)).toBe("balanced");
    expect(varianceState(-3, 2)).toBe("short");
    expect(varianceState(3, 2)).toBe("over");
  });

  it("ignores the sign of the tolerance it is given", () => {
    expect(varianceState(-1, -2)).toBe("balanced");
  });
});

describe("totalsByMethod", () => {
  const row = (
    orderId: string,
    method: string,
    amount: number,
    changeDue: number | null = null,
  ) => ({ orderId, method, amount, changeDue });

  it("reports cash net of change and other methods at face value", () => {
    expect(
      totalsByMethod([
        row("o1", "cash", 500, 100),
        row("o2", "card", 300),
        row("o3", "upi", 150),
      ]),
    ).toEqual({ cash: 400, card: 300, upi: 150 });
  });

  it("sums repeated methods", () => {
    expect(
      totalsByMethod([row("o1", "card", 100), row("o2", "card", 50)]),
    ).toEqual({ card: 150 });
  });

  // Inherits the per-order grouping rather than re-implementing it.
  it("does not double-subtract change on a split cash payment", () => {
    expect(
      totalsByMethod([row("o1", "cash", 100, 30), row("o1", "cash", 100, 30)]),
    ).toEqual({ cash: 170 });
  });

  it("omits methods that were never used", () => {
    expect(totalsByMethod([row("o1", "card", 100)])).toEqual({ card: 100 });
  });

  it("is empty for no payments", () => {
    expect(totalsByMethod([])).toEqual({});
  });
});

describe("round2", () => {
  // The job: stop float drift accumulating across a day of sales and surfacing
  // as a phantom variance.
  it("removes float drift", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1595.0000000000002)).toBe(1595);
  });

  it("keeps two decimals", () => {
    expect(round2(30.6)).toBe(30.6);
    expect(round2(111.9988)).toBe(112);
    expect(round2(1.234)).toBe(1.23);
  });

  // Documented, not aspirational: an exact half-paise like 1.005 is stored as
  // 1.00499…, so it rounds DOWN. Harmless here because every input is money
  // already at two decimals or a tax figure derived from it — nothing feeds
  // this a true half-paise — but the behaviour should be stated rather than
  // discovered during a cash count.
  it("rounds a float half-paise down, as JS does", () => {
    expect(round2(1.005)).toBe(1);
  });
});
