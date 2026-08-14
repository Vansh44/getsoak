/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

// placeOrder authenticates via getServerUser (the identity seam) and does every
// product read + order write through the Cloud SQL data layer (withService,
// RLS-bypassing), resolves the store from the host, re-validates the coupon, and
// rate-limits per user.
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => STORE),
  getCurrentStore: vi.fn(async () => ({ id: STORE, name: "Test Store" })),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));
// Store credit is a separate concern from what these tests assert (pricing,
// stock, coupons). Mocked so it neither adds a query to their fixture queues
// nor changes any amount — a 0 balance is exactly today's behaviour. Its own
// integration is covered in the "store credit" block at the bottom.
vi.mock("@/lib/credit/store-credit", () => ({
  getCreditBalance: vi.fn(async () => 0),
  spendCredit: vi.fn(async () => true),
  reinstateCreditForOrder: vi.fn(async () => 0),
}));
vi.mock("./coupon-actions", () => ({ validateCoupon: vi.fn() }));
// The fan-out is fire-and-forget, so stubbing it changes nothing about the
// order write — but it is the only way to assert WHO gets told WHAT, which is
// the whole point of the "unpaid gateway order" tests below.
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn(),
}));
// Online payments: the gateway loader (credential decrypt) and the Razorpay
// HTTP calls are mocked at the module boundary; the pure helpers
// (capturedPayment) keep their real implementations — they're unit-tested in
// lib/payments/payments.test.ts.
vi.mock("@/lib/payments/provider", () => ({
  getStoreGateway: vi.fn(),
  getPlatformRazorpayCreds: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    rzpCreateOrder: vi.fn(),
    rzpFetchOrderPayments: vi.fn(),
    verifyCheckoutSignature: vi.fn(),
  };
});

// The Cloud SQL data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_id: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
// Fulfilment routing is mocked at its own seam (its ranking is tested in
// lib/fulfilment/strategies.test.ts). Left real it would consume entries from
// the shared db mock queue and shift every later read.
vi.mock("@/lib/fulfilment/resolve", () => ({
  resolveFulfilmentLocation: vi.fn(async () => null),
}));
vi.mock("@/lib/shipping/quote", () => ({
  quoteShippingForOrder: vi.fn(),
}));

import {
  placeOrder,
  getCartStock,
  confirmOnlinePayment,
  reconcileMyOrderPayment,
  type CheckoutFormData,
} from "./checkout-actions";
import {
  getCreditBalance,
  spendCredit,
  reinstateCreditForOrder,
} from "@/lib/credit/store-credit";
import { getServerUser } from "@/lib/auth/server-user";
import { rateLimit } from "@/lib/rate-limit";
import { validateCoupon } from "./coupon-actions";
import { getStoreGateway } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  rzpFetchOrderPayments,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import { makeDbMock, sqlText, sqlParamValues } from "./_test-helpers";
import { orders, orderItems } from "@/drizzle/schema";
import { emitEvent } from "@/lib/notifications/record";
import type { CartItem } from "@/app/(storefront)/components/cart/CartProvider";
import { quoteShippingForOrder } from "@/lib/shipping/quote";

const STORE = "a0000000-0000-4000-8000-000000000001";

const validForm: CheckoutFormData = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "9876543210",
  addressLine1: "1 Analytical Engine Rd",
  city: "London",
  state: "England",
  postalCode: "SW1",
  country: "UK",
};

// One line, client-claimed price is deliberately absurd — the server must
// ignore it and re-price from the DB (100), so subtotal = 100 * 2 = 200.
function oneItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: "p1",
    slug: "prod",
    name: "Prod",
    variantId: null,
    variantName: null,
    price: 999999,
    basePrice: 999999,
    image: null,
    quantity: 2,
    ...overrides,
  };
}

// A DB product row as placeOrder's aliased select returns it (snake_case).
const productRow = (o: Record<string, any> = {}) => ({
  id: "p1",
  name: "Prod",
  selling_price: 100,
  store_id: STORE,
  tax_class_id: null,
  ...o,
});

// Find the db.execute() call that ran a given RPC by name.
const findRpc = (name: string) =>
  dbHolder.current.calls.execute.find((e: any) => sqlText(e).includes(name));

describe("placeOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy COD path: products, billing (tax off), taxClasses; one reserve_stock.
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [],
      error: "No courier available",
    });
  });

  it("★ a COD order IS announced at checkout — nothing is waiting on a gateway", async () => {
    // The other half of the rule. COD, pay-at-store and a credit-covered order
    // are complete the moment they are written, so deferring their confirmation
    // would mean it never arrived at all.
    await placeOrder(validForm, [oneItem()]);
    const placed = vi
      .mocked(emitEvent)
      .mock.calls.filter((c: any[]) => c[0]?.type === "order.placed");
    expect(placed).toHaveLength(1);
  });

  it("rejects an anonymous caller", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/logged in/i);
  });

  it("rejects an empty cart", async () => {
    const result = await placeOrder(validForm, []);
    expect("error" in result && result.error).toMatch(/empty/i);
  });

  it("rejects a cart with too many line items", async () => {
    const items = Array.from({ length: 101 }, (_, i) =>
      oneItem({ productId: `p${i}` }),
    );
    const result = await placeOrder(validForm, items);
    expect("error" in result && result.error).toMatch(/too many/i);
  });

  it("rejects a non-positive / non-integer quantity", async () => {
    const bad = await placeOrder(validForm, [oneItem({ quantity: 0 })]);
    expect("error" in bad && bad.error).toMatch(/invalid quantity/i);
    const frac = await placeOrder(validForm, [oneItem({ quantity: 1.5 })]);
    expect("error" in frac && frac.error).toMatch(/invalid quantity/i);
  });

  it("rejects when a required address field is missing", async () => {
    const result = await placeOrder({ ...validForm, city: "   " }, [oneItem()]);
    expect("error" in result && result.error).toMatch(/city is required/i);
  });

  it("rejects a phone number Shiprocket cannot deliver to", async () => {
    const result = await placeOrder(
      { ...validForm, phone: "+91 88888 88888" },
      [oneItem()],
    );
    expect("error" in result && result.error).toMatch(/valid 10-digit/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects when rate-limited", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/too many/i);
  });

  it("rejects when the product is not found in the host store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/not found/i);
  });

  it("re-prices from the DB (ignores the client-supplied price)", async () => {
    const result = await placeOrder(validForm, [oneItem()]);
    expect("success" in result && result.success).toBe(true);

    // Order total came from the DB price (100 * 2), not the client's 999999.
    const inserted = dbHolder.current.calls.values[0];
    expect(inserted.subtotal).toBe(200);
    expect(inserted.total).toBe(200);
    expect(inserted.storeId).toBe(STORE);
    expect(inserted.customerId).toBe("user-1");
    // Marked so cancellation restocks it exactly once (order-actions claim).
    expect(inserted.stockStatus).toBe("reserved");
  });

  it("re-quotes a physical order and snapshots the selected shipping promise", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          productRow({
            requires_shipping: true,
            weight_grams: 300,
            length_cm: 12,
            width_cm: 8,
            height_cm: 4,
          }),
        ],
        [],
        [],
      ],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [
        {
          id: "shiprocket:7",
          label: "Fast Courier",
          description: "Delivery in 2–3 days",
          amount: 50,
          carrierCost: 45,
          courierId: "7",
          courierName: "Fast Courier",
          estimatedDeliveryMinDays: 2,
          estimatedDeliveryMaxDays: 3,
          estimatedDeliveryAt: "2026-08-17T12:00:00.000Z",
          freeShippingApplied: false,
        },
      ],
    });

    const result = await placeOrder(
      { ...validForm, postalCode: "201301", country: "India" },
      [oneItem()],
      null,
      "cod",
      null,
      null,
      "shiprocket:7",
      50,
    );

    expect("success" in result && result.success).toBe(true);
    const inserted = dbHolder.current.calls.values[0];
    expect(inserted.shipping).toBe(50);
    expect(inserted.total).toBe(250);
    expect(inserted.shippingOption).toMatchObject({
      id: "shiprocket:7",
      courierId: "7",
      amount: 50,
      carrierCost: 45,
      provider: "shiprocket",
    });
  });

  it("does not silently charge a changed live delivery price", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow({ requires_shipping: true })], [], []],
    });
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [
        {
          id: "shiprocket:7",
          label: "Fast Courier",
          description: "Delivery in 2–3 days",
          amount: 60,
          carrierCost: 55,
          courierId: "7",
          courierName: "Fast Courier",
          estimatedDeliveryMinDays: 2,
          estimatedDeliveryMaxDays: 3,
          estimatedDeliveryAt: "2026-08-17T12:00:00.000Z",
          freeShippingApplied: false,
        },
      ],
    });

    const result = await placeOrder(
      { ...validForm, postalCode: "201301", country: "India" },
      [oneItem()],
      null,
      "cod",
      null,
      null,
      "shiprocket:7",
      50,
    );

    expect("error" in result && result.error).toMatch(/price changed/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("applies a validated coupon, rounds the discount, and increments usage", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      // increment_coupon_usage, then reserve_stock.
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem()], "SAVE10");
    expect("success" in result && result.success).toBe(true);

    const inserted = dbHolder.current.calls.values[0];
    // 10% of 200 = 20 (rounded), total 180.
    expect(inserted.discount).toBe(20);
    expect(inserted.total).toBe(180);
    expect(inserted.appliedCouponCode).toBe("SAVE10");

    // Usage reserved atomically via the RPC (single conditional UPDATE).
    const inc = findRpc("increment_coupon_usage");
    expect(inc).toBeTruthy();
    expect(sqlParamValues(inc)).toEqual(["SAVE10", STORE]);
  });

  it("refuses checkout when the coupon usage cap was hit concurrently", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    // The atomic reserve returns false → the last use was taken by another order.
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: false }]],
    });

    const result = await placeOrder(validForm, [oneItem()], "SAVE10");
    expect("error" in result && result.error).toMatch(/usage limit/i);
    expect(dbHolder.current.calls.insert).not.toContain(orders);
  });

  it("releases the reserved coupon use when the order items fail to save", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
      failInsertFor: [orderItems],
    });

    const result = await placeOrder(validForm, [oneItem()], "SAVE10");
    expect("error" in result && result.error).toMatch(/try again/i);
    // Orphan order deleted, and the reserved use handed back atomically.
    expect(dbHolder.current.calls.delete).toContain(orders);
    const dec = findRpc("decrement_coupon_usage");
    expect(dec).toBeTruthy();
    expect(sqlParamValues(dec)).toEqual(["SAVE10", STORE]);
  });

  it("bails out with the coupon error and does not create an order", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({ error: "expired" } as any);
    const result = await placeOrder(validForm, [oneItem()], "OLD");
    expect("error" in result && result.error).toMatch(/coupon error/i);
    expect(dbHolder.current.calls.insert).not.toContain(orders);
  });

  it("rolls back the order when order_items insertion fails", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
      failInsertFor: [orderItems],
    });

    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/try again/i);
    expect(dbHolder.current.calls.delete).toContain(orders);
  });

  it("fails checkout if stock cannot be reserved, reports the exact shortfall, and rolls back prior reservations", async () => {
    // Two items: the first reserves, the second fails; the post-failure re-read
    // reports 1 unit left, so the shopper is told the precise remaining quantity.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          productRow(),
          productRow({ id: "p2", name: "Product 2", selling_price: 150 }),
        ],
        [],
        [],
        [{ stock: 1 }], // availableStock() re-read
      ],
      executeQueue: [[{ reserved: true }], [{ reserved: false }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [
      oneItem({ productId: "p1" }),
      oneItem({ productId: "p2", name: "Product 2" }),
    ]);

    expect("error" in result && result.error).toMatch(
      /not enough stock for Product 2/i,
    );
    expect("error" in result && result.error).toMatch(/only 1 left/i);
    // release_stock was called for the first item that succeeded.
    const rel = findRpc("release_stock");
    expect(rel).toBeTruthy();
    const relParams = sqlParamValues(rel);
    expect(relParams).toContain("p1");
    expect(relParams).toContain("checkout_failed");
  });

  it("reports 'just sold out' when the live re-read shows zero left", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], [], [{ stock: 0 }]],
      executeQueue: [[{ reserved: false }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem({ productId: "p1" })]);
    expect("error" in result && result.error).toMatch(/just sold out/i);
    expect(dbHolder.current.calls.delete).toContain(orders);
  });

  it("creates the order before reserving stock, then reserves each line", async () => {
    // The ported flow inserts the order (805) before the reserve loop (877), so
    // the stock_movements.order_id FK is always satisfied. Assert both happened.
    const result = await placeOrder(validForm, [oneItem()]);
    expect("success" in result && result.success).toBe(true);
    expect(dbHolder.current.calls.insert).toContain(orders);
    const res = findRpc("reserve_stock");
    expect(res).toBeTruthy();
    const params = sqlParamValues(res);
    expect(params).toContain("p1");
    expect(params).toContain(2); // p_qty
  });
});

// getCartStock re-reads live stock for the cart, store-scoped, so the checkout
// page can reconcile a stale localStorage cart before the shopper commits.
describe("getCartStock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "p1", track_inventory: true, stock: 3, allow_backorder: false }],
      ],
    });
  });

  it("returns [] for an empty cart without touching the DB", async () => {
    expect(await getCartStock([])).toEqual([]);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("returns a fresh snapshot for a product line", async () => {
    const info = await getCartStock([{ productId: "p1", variantId: null }]);
    expect(info).toEqual([
      {
        productId: "p1",
        variantId: null,
        exists: true,
        trackInventory: true,
        stock: 3,
        allowBackorder: false,
      },
    ]);
  });

  it("marks a vanished product as exists:false", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const info = await getCartStock([{ productId: "gone", variantId: null }]);
    expect(info[0].exists).toBe(false);
  });

  it("resolves a variant line from the variant row (not the product)", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "p1", track_inventory: true, stock: 3, allow_backorder: false }],
        [{ id: "v1", track_inventory: true, stock: 2, allow_backorder: false }],
      ],
    });
    const info = await getCartStock([{ productId: "p1", variantId: "v1" }]);
    expect(info[0]).toMatchObject({ variantId: "v1", exists: true, stock: 2 });
  });

  it("marks a variant line exists:false when the variant is gone", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "p1", track_inventory: true, stock: 3, allow_backorder: false }],
        [],
      ],
    });
    const info = await getCartStock([{ productId: "p1", variantId: "vGone" }]);
    expect(info[0].exists).toBe(false);
  });
});

// A store with tax ENABLED: the product carries a tax class (GST 18%), read
// authoritatively from the DB. placeOrder snapshots the tax onto the order +
// each line and adjusts the total per the inclusive/exclusive mode.
describe("placeOrder — tax", () => {
  function taxSelectQueue(pricesIncludeTax: boolean) {
    return [
      [productRow({ tax_class_id: "tc1" })],
      [
        {
          tax_enabled: true,
          prices_include_tax: pricesIncludeTax,
          default_tax_class_id: null,
        },
      ],
      [{ id: "tc1", name: "GST 18%", rate: 18, sort_order: 0 }],
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
  });

  it("adds tax on top of the total when prices are exclusive", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: taxSelectQueue(false),
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const res = await placeOrder(validForm, [oneItem()]);
    expect("success" in res && res.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(200);
    expect(order.tax).toBe(36); // 200 * 18%
    expect(order.taxInclusive).toBe(false);
    expect(order.total).toBe(236); // subtotal + tax

    const items = dbHolder.current.calls.values[1];
    expect(items[0].taxRate).toBe(18);
    expect(items[0].taxAmount).toBe(36);
    expect(items[0].taxClassName).toBe("GST 18%");
  });

  it("carves tax out without changing the total when prices are inclusive", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: taxSelectQueue(true),
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const res = await placeOrder(validForm, [oneItem()]);
    expect("success" in res && res.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(200);
    expect(order.tax).toBe(30.51); // round2(200 * 18 / 118)
    expect(order.taxInclusive).toBe(true);
    expect(order.total).toBe(200); // unchanged — tax already inside the price

    const items = dbHolder.current.calls.values[1];
    expect(items[0].taxAmount).toBe(30.51);
  });
});

// ---------------------------------------------------------------------------
// Online payments (BYO Razorpay)
// ---------------------------------------------------------------------------

const GATEWAY = {
  creds: { keyId: "rzp_test_abc123", keySecret: "shh" },
  enabled: true,
};

describe("placeOrder — razorpay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // onlineGateway reads the stores row first, then the COD flow's selects.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ plan: "basic", plan_expires_at: null }],
        [productRow()],
        [],
        [],
      ],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD100110006" }],
    });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
    // ⚠ `clearAllMocks` clears CALLS, not IMPLEMENTATIONS, so the store-credit
    // block's balance used to leak in here: the order total stayed ₹200 (credit
    // is a payment, not a discount — §29) while the CHARGE dropped to ₹150, and
    // this suite's whole point is that the gateway is asked for the
    // server-computed amount. Reset explicitly so the razorpay tests describe a
    // customer with no credit.
    vi.mocked(getCreditBalance).mockResolvedValue(0);
    vi.mocked(getStoreGateway).mockResolvedValue(GATEWAY as any);
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: true,
      data: {
        id: "rzp_order_1",
        amount: 20000,
        currency: "INR",
        receipt: "ORD100110006",
        status: "created",
      },
    } as any);
  });

  it("★★ does NOT announce an unpaid gateway order — to anyone", async () => {
    // The bug this exists for: a shopper reached the Razorpay modal, paid
    // nothing, and both they and the merchant were emailed "New order ORD…
    // ₹39.00 · Paid online". If they close the modal the reaper cancels and
    // restocks that order 45 minutes later, so the confirmation described
    // something that no longer existed. The order row is still written — it has
    // to be, the gateway needs something to attach the payment to — but nothing
    // is ANNOUNCED until markOrderPaid claims the pending → paid transition.
    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("error" in res && res.error).toBeFalsy();

    const placed = vi
      .mocked(emitEvent)
      .mock.calls.filter((c: any[]) => c[0]?.type === "order.placed");
    expect(placed).toHaveLength(0);
  });

  it("rejects an unknown payment method", async () => {
    const res = await placeOrder(validForm, [oneItem()], null, "upi" as any);
    expect("error" in res && res.error).toMatch(/invalid payment method/i);
  });

  it("creates the Razorpay order for the SERVER-computed total and returns checkout params", async () => {
    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("success" in res && res.success).toBe(true);
    if (!("success" in res)) throw new Error("unreachable");

    // Amount derives from the DB price (100 × 2 = ₹200 = 20000 paise).
    expect(rzpCreateOrder).toHaveBeenCalledWith(GATEWAY.creds, {
      amountPaise: 20000,
      receipt: "ORD100110006",
      notes: { order_id: "order-1", store_id: STORE },
    });

    const inserted = dbHolder.current.calls.values[0];
    expect(inserted.paymentMethod).toBe("razorpay");
    expect(inserted.paymentStatus).toBe("pending");
    // The Razorpay order id is pinned to our order via an update.
    expect(dbHolder.current.calls.set).toContainEqual({
      razorpayOrderId: "rzp_order_1",
    });

    expect(res.payment).toEqual({
      rzpOrderId: "rzp_order_1",
      keyId: "rzp_test_abc123",
      amountPaise: 20000,
    });
  });

  it("refuses online payment when no gateway is connected/enabled", async () => {
    vi.mocked(getStoreGateway).mockResolvedValue(null);
    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("error" in res && res.error).toMatch(/cash on delivery/i);
    expect(dbHolder.current.calls.insert).not.toContain(orders);
  });

  it("refuses online payment when the plan doesn't include it (free)", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ plan: "free", plan_expires_at: null }]],
    });
    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("error" in res && res.error).toMatch(/cash on delivery/i);
    expect(dbHolder.current.calls.insert).not.toContain(orders);
  });

  it("rolls back stock, order and coupon when the Razorpay order can't be created", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ plan: "basic", plan_expires_at: null }],
        [productRow()],
        [],
        [],
      ],
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD100110006" }],
    });
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: false,
      error: "gateway down",
    } as any);

    const res = await placeOrder(validForm, [oneItem()], "SAVE10", "razorpay");
    expect("error" in res && res.error).toMatch(/try again/i);

    const rel = findRpc("release_stock");
    expect(rel).toBeTruthy();
    expect(sqlParamValues(rel)).toContain("order-1"); // p_order
    expect(dbHolder.current.calls.delete).toContain(orders);
    const dec = findRpc("decrement_coupon_usage");
    expect(dec).toBeTruthy();
    expect(sqlParamValues(dec)).toEqual(["SAVE10", STORE]);
  });

  it("rolls back when the rzp order id can't be pinned to our order", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ plan: "basic", plan_expires_at: null }],
        [productRow()],
        [],
        [],
      ],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD100110006" }],
      failUpdateFor: [orders], // the razorpay-order-id pin update fails
    });

    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("error" in res && res.error).toMatch(/try again/i);
    expect(dbHolder.current.calls.delete).toContain(orders);
  });
});

describe("confirmOnlinePayment", () => {
  const pendingOrder = {
    id: "order-1",
    payment_method: "razorpay",
    payment_status: "pending",
    razorpay_order_id: "rzp_order_1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ selectQueue: [[pendingOrder]] });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getStoreGateway).mockResolvedValue(GATEWAY as any);
    vi.mocked(verifyCheckoutSignature).mockReturnValue(true);
  });

  it("verifies the HMAC with the store secret and marks the order paid", async () => {
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect(res).toEqual({ success: true, paid: true });

    expect(verifyCheckoutSignature).toHaveBeenCalledWith(
      "shh",
      "rzp_order_1",
      "pay_1",
      "sig",
    );
    // The pending → paid transition is claimed via a conditional update.
    expect(dbHolder.current.calls.set).toContainEqual({
      paymentStatus: "paid",
      razorpayPaymentId: "pay_1",
    });
  });

  it("rejects a bad signature and leaves the order untouched", async () => {
    vi.mocked(verifyCheckoutSignature).mockReturnValue(false);
    const res = await confirmOnlinePayment("order-1", "pay_1", "bad");
    expect("error" in res && res.error).toMatch(/verification failed/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("is a no-op success when the order is already paid", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...pendingOrder, payment_status: "paid" }]],
    });
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect(res).toEqual({ success: true, paid: true });
    expect(verifyCheckoutSignature).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects an anonymous caller", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect("error" in res && res.error).toMatch(/logged in/i);
  });

  it("rejects when the order isn't the caller's / isn't razorpay", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect("error" in res && res.error).toMatch(/not found/i);
  });
});

describe("reconcileMyOrderPayment", () => {
  const pendingOrder = {
    id: "order-1",
    payment_method: "razorpay",
    payment_status: "pending",
    razorpay_order_id: "rzp_order_1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ selectQueue: [[pendingOrder]] });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getStoreGateway).mockResolvedValue(GATEWAY as any);
  });

  it("marks the order paid when Razorpay reports a captured payment", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [
        { id: "pay_f", order_id: "rzp_order_1", amount: 1, status: "failed" },
        {
          id: "pay_ok",
          order_id: "rzp_order_1",
          amount: 20000,
          status: "captured",
        },
      ],
    } as any);

    const res = await reconcileMyOrderPayment("order-1");
    expect(res).toEqual({ success: true, paid: true });
    expect(dbHolder.current.calls.set).toContainEqual({
      paymentStatus: "paid",
      razorpayPaymentId: "pay_ok",
    });
  });

  it("reports unpaid (without cancelling) when nothing was captured", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [],
    } as any);

    const res = await reconcileMyOrderPayment("order-1");
    expect(res).toEqual({ success: true, paid: false });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Store credit at checkout (roadmap Step 4 / returns-exchanges-plan Step 7)
// ---------------------------------------------------------------------------

describe("placeOrder — store credit", () => {
  /** The happy COD fixture, with a balance to spend. */
  function seedWithCredit(balance: number) {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
    vi.mocked(getCreditBalance).mockResolvedValue(balance);
    vi.mocked(spendCredit).mockResolvedValue(true);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spends credit against the order and records how much", async () => {
    seedWithCredit(50);
    const res = await placeOrder(validForm, [oneItem()]);
    expect("error" in res && res.error).toBeFalsy();

    expect(spendCredit).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "user-1", orderId: "order-1" }),
    );
    // ★ Recorded on the order, NOT netted off the total — credit is a payment,
    // not a discount, and the invoice/GST must still reflect the goods value.
    const stamped = dbHolder.current.calls.set.find(
      (v: any) => v && "storeCreditUsed" in v,
    );
    expect(stamped.storeCreditUsed).toBe(50);
  });

  it("★ leaves orders.total alone — it is the goods value, not the amount due", async () => {
    // Netting credit off would understate the sale on the invoice and compute
    // GST on the wrong base. So the SAME basket must write the SAME total
    // whether or not credit was applied.
    const totalFor = async (balance: number) => {
      seedWithCredit(balance);
      await placeOrder(validForm, [oneItem()]);
      return dbHolder.current.calls.values.find(
        (v: any) => v && !Array.isArray(v) && "subtotal" in v,
      ).total;
    };
    const withoutCredit = await totalFor(0);
    const withCredit = await totalFor(50);
    expect(withCredit).toBe(withoutCredit);
  });

  it("does nothing when the customer has no balance", async () => {
    seedWithCredit(0);
    await placeOrder(validForm, [oneItem()]);
    expect(spendCredit).not.toHaveBeenCalled();
  });

  it("★ never refuses the sale when the balance moved underneath it", async () => {
    // Invariant 6: never refuse a sale over an optional feature. A race on the
    // balance means they pay the full amount, not that checkout fails.
    seedWithCredit(50);
    vi.mocked(spendCredit).mockResolvedValue(false);
    const res = await placeOrder(validForm, [oneItem()]);
    expect("error" in res && res.error).toBeFalsy();
    const stamped = dbHolder.current.calls.set.find(
      (v: any) => v && "storeCreditUsed" in v,
    );
    expect(stamped).toBeUndefined();
  });

  it("★ marks a fully-covered order PAID, with nothing to collect", async () => {
    // Otherwise a COD courier is told to collect ₹0 and the gateway would be
    // asked for an amount it refuses.
    seedWithCredit(500);
    await placeOrder(validForm, [oneItem()]);
    const paid = dbHolder.current.calls.set.find(
      (v: any) => v && v.paymentMethod === "store_credit",
    );
    expect(paid).toMatchObject({
      paymentMethod: "store_credit",
      paymentStatus: "paid",
    });
  });

  it("does not mark a partly-covered order paid", async () => {
    seedWithCredit(50);
    await placeOrder(validForm, [oneItem()]);
    const paid = dbHolder.current.calls.set.find(
      (v: any) => v && v.paymentMethod === "store_credit",
    );
    expect(paid).toBeUndefined();
  });

  it("doesn't look up a balance for a signed-out shopper", async () => {
    seedWithCredit(50);
    vi.mocked(getServerUser).mockResolvedValue(null as any);
    await placeOrder(validForm, [oneItem()]);
    expect(spendCredit).not.toHaveBeenCalled();
    expect(reinstateCreditForOrder).not.toHaveBeenCalled();
  });

  it("★★ a failed stamp GIVES THE CREDIT BACK rather than leaving the order lying", async () => {
    // `store_credit_used` is not bookkeeping — `refundableAmount` subtracts it
    // to work out how much MONEY the order actually took. Spending the balance
    // while the column stays 0 makes the order read as fully paid in money, so
    // a later cash or manual refund hands back credit the store never received.
    // There is no gateway backstop on those methods.
    seedWithCredit(50);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
      failUpdateFor: [orders],
    });

    const res = await placeOrder(validForm, [oneItem()]);

    // The sale still completes — never refuse a sale over an optional feature.
    expect("error" in res && res.error).toBeFalsy();
    // And the balance goes straight back, so ledger and order agree.
    expect(reinstateCreditForOrder).toHaveBeenCalledWith(STORE, "order-1");
  });
});
