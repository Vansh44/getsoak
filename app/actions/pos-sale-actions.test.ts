/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlText } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
  clientIp: vi.fn(() => "1.2.3.4"),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreSettings } from "@/lib/settings/resolve";
import { placePosSale } from "./pos-sale-actions";

const CASHIER = {
  role: "cashier" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

const SETTINGS = {
  "pos.allowPriceOverride": true,
  "pos.requireManagerForDiscount": true,
  "pos.maxDiscountPercent": 10,
} as any;

// A ₹100 product, 18% GST, exclusive pricing, supplier in state 07.
const PRODUCT = {
  id: "p1",
  name: "Cold Brew",
  selling_price: 100,
  tax_class_id: "tc1",
  hsn_code: "2202",
};
const BILLING = {
  store_id: "store-1",
  tax_enabled: true,
  prices_include_tax: false,
  default_tax_class_id: "tc1",
  gst_enabled: true,
};
const TAX_CLASS = { id: "tc1", name: "GST 18%", rate: 18, sort_order: 0 };

/**
 * placePosSale's reads, in order:
 *  1 products, 2 variants(skipped when none), 3 billing, 4 tax classes,
 *  5 location state, 6 receipt prefix.
 * db.execute() calls (receipt seq, reserve_stock_at) come from executeQueue.
 */
function seedHappyPath(over: { productRows?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      over.productRows ?? [PRODUCT], // 1 products
      [BILLING], // 2 billing (variants skipped: no variantIds)
      [TAX_CLASS], // 3 tax classes
      [{ state_code: "07" }], // 4 location state
      [{ prefix: "DEL" }], // 5 receipt prefix
    ],
    executeQueue: [
      [{ seq: 42 }], // next_pos_receipt_no
      [{ reserved: true }], // reserve_stock_at
    ],
    returning: [{ id: "o1", order_ref: "ORD100110006" }],
  });
}

const line = { productId: "p1", variantId: null, quantity: 1 };
const cash = [{ method: "cash" as const, amount: 118, tendered: 200 }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  vi.mocked(getStoreSettings).mockResolvedValue(SETTINGS);
  seedHappyPath();
});

describe("placePosSale — gates", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await placePosSale([line], cash)).error).toMatch(/signed out/i);
  });

  it("rejects an empty cart and a cart with no payment", async () => {
    expect((await placePosSale([], cash)).error).toMatch(/empty/i);
    expect((await placePosSale([line], [])).error).toMatch(/take a payment/i);
  });

  it("rejects invalid quantities and unknown tender methods", async () => {
    expect(
      (await placePosSale([{ ...line, quantity: 0 }], cash)).error,
    ).toMatch(/quantity/i);
    expect(
      (await placePosSale([{ ...line, quantity: 1.5 }], cash)).error,
    ).toMatch(/quantity/i);
    expect(
      (await placePosSale([line], [{ method: "crypto", amount: 5 } as any]))
        .error,
    ).toMatch(/payment method/i);
  });

  it("refuses a product that isn't in this store", async () => {
    seedHappyPath({ productRows: [] });
    expect((await placePosSale([line], cash)).error).toMatch(
      /no longer available/i,
    );
  });
});

describe("placePosSale — pricing is server-authoritative", () => {
  it("prices from the DB and computes GST, ignoring client-side money", async () => {
    const r = await placePosSale([line], cash);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    // ₹100 + 18% = ₹118, priced entirely from the DB row.
    expect(order.subtotal).toBe(100);
    expect(order.tax).toBe(18);
    expect(order.total).toBe(118);
    expect(order.salesChannel).toBe("pos");
    expect(order.status).toBe("completed");
    expect(order.paymentStatus).toBe("paid");
    // A walk-in has no account and no delivery address.
    expect(order.customerId).toBeNull();
    expect(order.shippingAddress).toBeNull();
    // Sale context for the receipt + reporting.
    expect(order.locationId).toBe("loc-1");
    expect(order.cashierId).toBe("st1");
    expect(order.cashierName).toBe("Priya");
    expect(r.receiptNo).toBe("DEL-000042");
  });

  it("splits GST into CGST+SGST for an intra-state sale", async () => {
    await placePosSale([line], cash);
    const items = dbHolder.current.calls.values[1];
    expect(items[0]).toMatchObject({
      taxAmount: 18,
      taxCgst: 9,
      taxSgst: 9,
      taxIgst: 0,
      hsnCode: "2202",
    });
  });

  it("returns change for an over-tender and records it", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 200, tendered: 200 }],
    );
    expect(r.changeDue).toBe(82); // 200 - 118
    const payments = dbHolder.current.calls.values[2];
    expect(payments[0]).toMatchObject({
      method: "cash",
      amount: 200,
      changeDue: 82,
    });
  });

  it("refuses when the tenders don't cover the total", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 50 }]);
    expect(r.error).toMatch(/doesn't cover/i);
    // Nothing was written.
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses change on a non-cash overpayment", async () => {
    const r = await placePosSale([line], [{ method: "card", amount: 500 }]);
    expect(r.error).toMatch(/only a cash payment/i);
  });

  it("records split tenders as separate rows", async () => {
    const r = await placePosSale(
      [line],
      [
        { method: "cash", amount: 18, tendered: 18 },
        { method: "card", amount: 100, reference: "APPROVED-77" },
      ],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].paymentMethod).toBe("split");
    const payments = dbHolder.current.calls.values[2];
    expect(payments).toHaveLength(2);
    expect(payments[1]).toMatchObject({
      method: "card",
      amount: 100,
      reference: "APPROVED-77",
    });
  });
});

describe("placePosSale — discount cap needs a manager", () => {
  it("blocks a cashier discounting past the cap", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50, // 50% of a ₹100 sale, cap is 10%
    });
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("allows it once a manager PIN has approved", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50, managerApproved: true },
    );
    expect(r.error).toBeUndefined();
    const order = dbHolder.current.calls.values[0];
    expect(order.discount).toBe(50);
    // ₹100 − ₹50 discount = ₹50 taxable, +18% = ₹59.
    expect(order.total).toBe(59);
  });

  it("lets a manager discount freely", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50 },
    );
    expect(r.needsApproval).toBeUndefined();
    expect(r.success).toBe(true);
  });
});

describe("placePosSale — stock", () => {
  it("reserves at the register's location", async () => {
    await placePosSale([line], cash);
    const reserveCall = dbHolder.current.calls.execute.find((c: any) =>
      sqlText(c).includes("reserve_stock_at"),
    );
    expect(reserveCall).toBeTruthy();
    expect(sqlText(reserveCall)).toContain("p_location");
  });

  // Overselling must fail the whole sale, not silently sell air.
  it("rolls the order back when stock is short", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [PRODUCT],
        [BILLING],
        [TAX_CLASS],
        [{ state_code: "07" }],
        [{ prefix: "DEL" }],
      ],
      executeQueue: [[{ seq: 43 }], [{ reserved: false }]],
      returning: [{ id: "o1", order_ref: "ORD1" }],
    });

    const r = await placePosSale([line], cash);
    expect(r.error).toMatch(/not enough stock/i);
    // The order row that was created first is deleted again.
    expect(dbHolder.current.calls.delete).toHaveLength(1);
  });
});
