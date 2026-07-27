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

import { withService } from "@/lib/db/client";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreSettings } from "@/lib/settings/resolve";
import {
  getCatalogSnapshot,
  placePosSale,
  searchPosCustomers,
} from "./pos-sale-actions";

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

describe("getCatalogSnapshot", () => {
  // Two reads per page: the page of product ids, then their sellable SKUs.
  const page = (ids: string[], rows: any[]) => [
    ids.map((id) => ({ id })),
    rows,
  ];
  const row = (over: any = {}) => ({
    product_id: "p1",
    variant_id: null,
    name: "Cold Brew",
    variant_name: null,
    p_sku: "SKU1",
    v_sku: null,
    p_barcode: "890123",
    v_barcode: null,
    p_price: 100,
    v_price: null,
    v_special: null,
    p_image: "https://img/x.webp",
    v_image: null,
    p_track: true,
    v_track: null,
    p_backorder: false,
    v_backorder: null,
    p_stock: 999,
    v_stock: null,
    loc_stock: 4,
    ...over,
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    const r = await getCatalogSnapshot();
    expect(r.error).toMatch(/signed in/i);
    expect(r.items).toEqual([]);
  });

  it("refuses a role that can't sell", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "nobody",
    } as any);
    expect((await getCatalogSnapshot()).error).toMatch(/not allowed/i);
  });

  // The whole point of the cache: it must carry stock for THIS register's
  // location, not the cross-location aggregate in products.stock.
  it("reports stock at the operator's location, not the aggregate", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p1"], [row()]) });
    const r = await getCatalogSnapshot();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      productId: "p1",
      barcode: "890123",
      price: 100,
      image: "https://img/x.webp",
      stock: 4,
    });
  });

  it("prefers a variant's special price and falls back to the product image", () => {
    dbHolder.current = makeDbMock({
      selectQueue: page(
        ["p1"],
        [
          row({
            variant_id: "v1",
            variant_name: "Large",
            v_price: 150,
            v_special: 120,
            v_image: null,
            v_track: true,
            loc_stock: 2,
          }),
        ],
      ),
    });
    return getCatalogSnapshot().then((r) => {
      expect(r.items[0]).toMatchObject({
        variantId: "v1",
        price: 120,
        image: "https://img/x.webp",
        stock: 2,
      });
    });
  });

  it("ends paging with a null cursor on a short page", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p1"], [row()]) });
    expect((await getCatalogSnapshot()).nextCursor).toBeNull();
  });

  it("returns an empty page (not an error) once the catalog is drained", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await getCatalogSnapshot("p-last");
    expect(r).toMatchObject({ items: [], nextCursor: null });
    expect(r.error).toBeUndefined();
  });

  // Keyset paging, not OFFSET — pages stay stable while the catalog is edited.
  it("pages forward from the cursor", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p2"], [row()]) });
    await getCatalogSnapshot("p1");
    expect(sqlText(dbHolder.current.calls.where[0])).toMatch(/>/);
  });

  // An empty catalog and an unreachable database look identical to the
  // register otherwise — and one of them must not silently blank the grid.
  it("surfaces a DB failure instead of reporting an empty catalog", async () => {
    vi.mocked(withService).mockRejectedValueOnce(new Error("connection reset"));
    const r = await getCatalogSnapshot();
    expect(r.error).toBeTruthy();
    expect(r.items).toEqual([]);
  });
});

describe("placePosSale — customer attach", () => {
  // With a customerId the ownership lookup runs FIRST, ahead of the pricing
  // reads, so the queue gains a leading row.
  const seedWithCustomer = (owner: any[]) =>
    (dbHolder.current = makeDbMock({
      selectQueue: [
        owner, // 0 users (ownership check)
        [PRODUCT],
        [BILLING],
        [TAX_CLASS],
        [{ state_code: "07" }],
        [{ prefix: "DEL" }],
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    }));

  it("attaches a customer who belongs to this store", async () => {
    seedWithCustomer([{ id: "cust-1" }]);
    const r = await placePosSale([line], cash, { customerId: "cust-1" });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerId).toBe("cust-1");
  });

  // THE tenant-isolation guarantee. Without the ownership check the sale would
  // be filed against another store's customer, who holds RLS SELECT on their
  // own orders and would then see a foreign order in their history.
  it("refuses a customer id belonging to another store", async () => {
    seedWithCustomer([]); // no row matches (id AND store_id)
    const r = await placePosSale([line], cash, { customerId: "other-store" });
    expect(r.error).toMatch(/isn't in this store/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("treats a blank customer id as a walk-in", async () => {
    const r = await placePosSale([line], cash, { customerId: "   " });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerId).toBeNull();
  });
});

describe("placePosSale — GSTIN", () => {
  it("normalises a valid GSTIN to upper case", async () => {
    const r = await placePosSale([line], cash, {
      customerGstin: " 22aaaaa0000a1z5 ",
    });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerGstin).toBe(
      "22AAAAA0000A1Z5",
    );
  });

  // It prints on the customer's invoice, so a malformed one is rejected at the
  // boundary rather than immortalised on a document.
  it("rejects a malformed GSTIN before writing anything", async () => {
    const r = await placePosSale([line], cash, {
      customerGstin: "NOT-A-GSTIN",
    });
    expect(r.error).toMatch(/gstin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("treats a blank GSTIN as absent", async () => {
    const r = await placePosSale([line], cash, { customerGstin: "  " });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerGstin).toBeNull();
  });
});

describe("placePosSale — line discounts", () => {
  const twoOf = { productId: "p1", variantId: null, quantity: 2 };

  it("reduces the line amount and the order total", async () => {
    // 2 x ₹100 = ₹200, less ₹30 = ₹170, +18% = ₹200.60 -> 201
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 30 }],
      [{ method: "cash", amount: 201, tendered: 201 }],
      { managerApproved: true }, // 15% is over the 10% cap
    );
    expect(r.success).toBe(true);
    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(200);
    expect(order.discount).toBe(30);
    const items = dbHolder.current.calls.values[1];
    expect(items[0].lineDiscount).toBe(30);
    expect(items[0].total).toBe(170);
  });

  // A markdown larger than the line would otherwise make the line negative and
  // quietly discount the rest of the sale.
  it("caps a line discount at the line's own value", async () => {
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 9999 }],
      [{ method: "cash", amount: 1, tendered: 1 }],
      { managerApproved: true },
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(200);
    expect(dbHolder.current.calls.values[1][0].total).toBe(0);
  });

  // The cap is on TOTAL generosity — line and order discounts together — so a
  // cashier can't stay under it by splitting the giveaway across both.
  it("counts line discounts toward the manager-approval cap", async () => {
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 50 }], // 25% of ₹200; cap is 10%
      [{ method: "cash", amount: 1 }],
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("ignores a negative or non-numeric line discount", async () => {
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: -50 }],
      [{ method: "cash", amount: 236, tendered: 236 }],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(0);
  });
});

describe("searchPosCustomers", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await searchPosCustomers("ravi")).error).toMatch(/signed in/i);
  });

  // A one-character search would stream a large slice of the customer list to
  // a shared till for no benefit.
  it("returns nothing below the 2-character floor without querying", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "c1" }]] });
    const r = await searchPosCustomers("r");
    expect(r.customers).toEqual([]);
    expect(dbHolder.current.calls.where).toHaveLength(0);
  });

  // sqlText renders operators without column names, so this asserts the
  // SHAPE: an equality (the store scope) AND-ed ahead of the name/phone/email
  // OR group. Drop the store scope and the leading `=` disappears.
  it("scopes the search to the operator's store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await searchPosCustomers("ravi");
    expect(sqlText(dbHolder.current.calls.where[0])).toMatch(
      /^\( = {2}and \( ilike( {2}or {2}ilike)+ \)\)$/,
    );
  });

  it("builds a display name and falls back to the phone", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "c1",
            phone: "9876543210",
            email: "r@x.com",
            first_name: "Ravi",
            last_name: "Kumar",
          },
          {
            id: "c2",
            phone: "9000000000",
            email: null,
            first_name: "",
            last_name: null,
          },
        ],
      ],
    });
    const r = await searchPosCustomers("ravi");
    expect(r.customers[0]).toMatchObject({ name: "Ravi Kumar", id: "c1" });
    expect(r.customers[1].name).toBe("9000000000");
  });
});
