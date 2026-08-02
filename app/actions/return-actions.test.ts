/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";
import { resolveStoreSettings } from "@/lib/settings/registry";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  requireStorefrontStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/inventory/alerts", () => ({ reportStockChanges: vi.fn() }));
vi.mock("@/lib/inventory/reservations", () => ({
  holdStock: vi.fn(async () => "hold-1"),
  commitHold: vi.fn(async () => true),
  releaseHold: vi.fn(async () => true),
}));
vi.mock("@/lib/fulfilment/resolve", () => ({
  resolveFulfilmentLocation: vi.fn(async () => "loc-1"),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_id: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getServerUser } from "@/lib/auth/server-user";
import { getStoreSettings } from "@/lib/settings/resolve";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import { emitEvent } from "@/lib/notifications/record";
import {
  commitHold,
  holdStock,
  releaseHold,
} from "@/lib/inventory/reservations";
import {
  cancelMyReturn,
  requestReturn,
  reviewReturn,
  receiveReturn,
} from "./return-actions";

const USER = { id: "cust-1", email: "ada@example.test" };
const ADMIN = { uid: "admin-1", email: "owner@shop.test" };

function settings(overrides: Record<string, boolean | number> = {}) {
  return {
    ...resolveStoreSettings(null, "pro"),
    "returns.enabled": true,
    "returns.selfServe": true,
    "returns.windowDays": 7,
    "returns.requireReason": true,
    ...overrides,
  } as any;
}

/** A delivered order with one ₹100 × 2 line, delivered yesterday. */
function seedOrder(
  opts: {
    orderOver?: Record<string, unknown>;
    itemOver?: Record<string, unknown>;
    returnedUnits?: number;
    existing?: any[];
    variants?: any[];
  } = {},
) {
  const order = {
    id: "o1",
    order_ref: "ORD10011027",
    status: "delivered",
    discount: 0,
    created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    delivered_at: new Date(Date.now() - 86_400_000).toISOString(),
    collected_at: null,
    ...opts.orderOver,
  };
  const item = {
    id: "li-a",
    name: "Amul Taaza Toned Milk",
    variant_name: null,
    quantity: 2,
    price: 100,
    total: 200,
    line_discount: 0,
    tax_amount: 10,
    product_id: "p1",
    variant_id: "v-m",
    product_returnable: true,
    product_window: null,
    ...opts.itemOver,
  };
  const returnedRows = opts.returnedUnits
    ? [{ order_item_id: "li-a", qty: opts.returnedUnits }]
    : [];

  // Other variants of the same product, offered as swap targets.
  const variants = opts.variants ?? [];

  dbHolder.current = makeDbMock({
    // getReturnableOrder: order → items → countReturnedUnits → existing
    //                     → loadSwapOptions
    // then (in requestReturn) priceReturn: items → order → countReturnedUnits
    selectQueue: [
      [order],
      [item],
      returnedRows,
      opts.existing ?? [],
      variants,
      [item],
      [order],
      returnedRows,
    ],
    returning: [{ id: "ret-1" }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getServerUser as any).mockResolvedValue(USER);
  (getManagerIdentity as any).mockResolvedValue(ADMIN);
  (getStoreSettings as any).mockResolvedValue(settings());
  (rateLimit as any).mockResolvedValue({ allowed: true });
  seedOrder();
});

describe("requestReturn — gates", () => {
  it("refuses an anonymous caller", async () => {
    (getServerUser as any).mockResolvedValue(null);
    const res = await requestReturn({ orderId: "o1", lines: [] });
    expect(res.error).toContain("sign in");
  });

  it("★ refuses when the store hasn't switched returns on", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.enabled": false }),
    );
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.error).toContain("doesn't accept returns");
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("★ refuses when self-serve is off — a rendered form is not a permission", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.selfServe": false }),
    );
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.error).toContain("contact the store");
  });

  it("refuses when rate-limited", async () => {
    (rateLimit as any).mockResolvedValue({ allowed: false });
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.error).toContain("Too many attempts");
  });

  it("demands a reason when the store requires one", async () => {
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
    });
    expect(res.error).toContain("why");
  });

  it("refuses an empty basket", async () => {
    const res = await requestReturn({ orderId: "o1", lines: [] });
    expect(res.error).toContain("Choose what");
  });
});

describe("requestReturn — the client never decides what's allowed", () => {
  it("★ refuses a FINAL SALE line even when the client sends it", async () => {
    seedOrder({ itemOver: { product_returnable: false } });
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.error).toContain("can't be returned");
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("★ refuses once the window has closed", async () => {
    seedOrder({
      orderOver: {
        delivered_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      },
    });
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.error).toContain("window");
  });

  it("refuses an order that hasn't arrived yet", async () => {
    seedOrder({ orderOver: { status: "shipped", delivered_at: null } });
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.error).toContain("once it arrives");
  });

  it("★ clamps a quantity beyond what's left", async () => {
    // The client asked for 99 of a 2-unit line with 1 already returned.
    seedOrder({ returnedUnits: 1 });
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 99 }],
      reasonCode: "changed_mind",
    });
    expect(res.returnId).toBeTruthy();
    const items = dbHolder.current.calls.values[1];
    expect(items[0].quantity).toBe(1);
  });
});

describe("requestReturn — fees follow the reason", () => {
  it("★ waives fees when the store was at fault", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({
        "returns.restockingFeePercent": 10,
        "returns.returnShippingFee": 50,
      }),
    );
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 2 }],
      reasonCode: "damaged",
    });
    const row = dbHolder.current.calls.values[0];
    expect(row.restockingFee).toBe(0);
    expect(row.returnShippingFee).toBe(0);
    // Goods 200 + tax 10, nothing deducted.
    expect(res.refundAmount).toBe(210);
  });

  it("charges them on a change of mind", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({
        "returns.restockingFeePercent": 10,
        "returns.returnShippingFee": 50,
      }),
    );
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 2 }],
      reasonCode: "changed_mind",
    });
    const row = dbHolder.current.calls.values[0];
    expect(row.restockingFee).toBe(20); // 10% of 200
    expect(row.returnShippingFee).toBe(50);
    expect(res.refundAmount).toBe(140); // 210 − 70
  });
});

describe("requestReturn — auto-approve", () => {
  it("auto-approves a no-fault reason when the store allows it", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.autoApprove": true }),
    );
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.autoApproved).toBe(true);
    expect(dbHolder.current.calls.values[0].status).toBe("approved");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.return_approved" }),
    );
  });

  it("★ NEVER auto-approves a fault claim, even with autoApprove on", async () => {
    // "Arrived damaged" waives every fee, so auto-approving it would let
    // anyone opt out of the store's return charges by picking the right radio
    // button. Those always go to a person.
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.autoApprove": true }),
    );
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "damaged",
    });
    expect(res.autoApproved).toBe(false);
    expect(dbHolder.current.calls.values[0].status).toBe("requested");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.return_requested" }),
    );
  });

  it("stays pending when autoApprove is off", async () => {
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.autoApproved).toBe(false);
    expect(dbHolder.current.calls.values[0].status).toBe("requested");
  });
});

describe("reviewReturn", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ order_ref: "ORD1", customer_id: "cust-1" }]],
      returning: [
        {
          id: "ret-1",
          order_id: "o1",
          total: 210,
          restocking_fee: 0,
          return_shipping_fee: 0,
        },
      ],
    });
  });

  it("refuses an unauthenticated caller", async () => {
    (getManagerIdentity as any).mockResolvedValue(null);
    expect((await reviewReturn("ret-1", "approve")).error).toBe(
      "Not authenticated",
    );
  });

  it("approves and tells the customer", async () => {
    const res = await reviewReturn("ret-1", "approve");
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.set[0].status).toBe("approved");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.return_approved" }),
    );
  });

  it("★ REFUSES to decline without a reason", async () => {
    // The customer reads this text verbatim. A silent no is the most
    // complained-about thing a returns process does.
    const res = await reviewReturn("ret-1", "reject");
    expect(res.error).toContain("why");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("declines with the note, and passes it to the customer", async () => {
    const res = await reviewReturn("ret-1", "reject", "Past the 7-day window.");
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.set[0].reviewNote).toBe(
      "Past the 7-day window.",
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.return_rejected",
        payload: expect.objectContaining({ note: "Past the 7-day window." }),
      }),
    );
  });

  it("★ loses the race gracefully when it's already been decided", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]], returning: [] });
    const res = await reviewReturn("ret-1", "approve");
    expect(res.error).toContain("already been decided");
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("rejects an invalid decision", async () => {
    expect((await reviewReturn("ret-1", "maybe" as any)).error).toContain(
      "Invalid",
    );
  });
});

describe("receiveReturn", () => {
  function seedReceive(condition?: "sellable" | "damaged") {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "rri-1",
            order_item_id: "li-a",
            quantity: 2,
            product_id: "p1",
            variant_id: null,
          },
        ],
      ],
      returning: [{ id: "ret-1", order_id: "o1", location_id: null }],
    });
    return condition;
  }

  it("★ restocks only SELLABLE units", async () => {
    seedReceive();
    const res = await receiveReturn("ret-1", [
      { orderItemId: "li-a", condition: "sellable" },
    ]);
    expect(res.ok).toBe(true);
    expect(res.restocked).toBe(1);
    // One adjust_stock RPC ran.
    expect(dbHolder.current.calls.execute).toHaveLength(1);
  });

  it("★ does NOT restock a DAMAGED line", async () => {
    // A dented tin coming back is not stock. Restocking it is how a shop sells
    // the same broken thing twice.
    seedReceive();
    const res = await receiveReturn("ret-1", [
      { orderItemId: "li-a", condition: "damaged" },
    ]);
    expect(res.restocked).toBe(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    // …but the condition IS recorded.
    expect(dbHolder.current.calls.set[1]).toMatchObject({
      condition: "damaged",
    });
  });

  it("defaults to sellable when no condition is given", async () => {
    seedReceive();
    const res = await receiveReturn("ret-1", []);
    expect(res.restocked).toBe(1);
  });

  it("★ refuses a return that hasn't been approved", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]], returning: [] });
    const res = await receiveReturn("ret-1", []);
    expect(res.error).toContain("isn't waiting to be received");
  });
});

describe("cancelMyReturn", () => {
  it("withdraws a request that's still waiting", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: "ret-1", order_id: "o1" }],
    });
    expect((await cancelMyReturn("ret-1")).ok).toBe(true);
  });

  it("★ can't withdraw one the store has already approved", async () => {
    // The claim's WHERE pins status = 'requested', so an approved return
    // matches nothing rather than being silently reopened.
    dbHolder.current = makeDbMock({ returning: [] });
    const res = await cancelMyReturn("ret-1");
    expect(res.error).toContain("no longer be withdrawn");
  });

  it("refuses an anonymous caller", async () => {
    (getServerUser as any).mockResolvedValue(null);
    expect((await cancelMyReturn("ret-1")).error).toContain("sign in");
  });
});

describe("requestReturn — exchanges", () => {
  /** A large variant of the same product, in stock, same price as the medium. */
  const LARGE = {
    id: "v-l",
    product_id: "p1",
    name: "1 L",
    base_price: 100,
    selling_price: 100,
    track_inventory: true,
    stock: 5,
    allow_backorder: false,
  };

  function swapReq(variantId: string | null = "v-l") {
    return {
      orderId: "o1",
      lines: [
        { orderItemId: "li-a", quantity: 1, exchangeVariantId: variantId },
      ],
      reasonCode: "size_fit",
    };
  }

  it("records the swap target and holds the replacement", async () => {
    seedOrder({ variants: [LARGE] });
    const res = await requestReturn(swapReq());

    expect(res.error).toBeUndefined();
    expect(res.isExchange).toBe(true);

    const items = dbHolder.current.calls.values[1];
    expect(items[0].exchangeVariantId).toBe("v-l");
    expect(items[0].exchangeProductId).toBe("p1");
    // ★ Snapshotted — re-reading it at receipt would bill them for a
    // repricing they were never quoted.
    expect(items[0].exchangePrice).toBe(100);

    // ★ Held at REQUEST time, so the size can't sell out in transit.
    expect(holdStock).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p1",
        variantId: "v-l",
        quantity: 1,
        owner: "exchange",
        ownerId: "ret-1",
      }),
    );
  });

  it("★ REFUSES a swap for something dearer", async () => {
    // Collecting the difference is a payment flow that doesn't exist outside
    // checkout. Refused with a sentence saying what to do instead.
    seedOrder({ variants: [{ ...LARGE, selling_price: 250 }] });
    const res = await requestReturn(swapReq());
    expect(res.error).toContain("more than what you're sending back");
    expect(res.error).toContain("new order");
    expect(holdStock).not.toHaveBeenCalled();
  });

  it("allows a swap for something CHEAPER — the store owes the difference", async () => {
    seedOrder({ variants: [{ ...LARGE, selling_price: 60 }] });
    const res = await requestReturn(swapReq());
    expect(res.error).toBeUndefined();
    expect(res.isExchange).toBe(true);
  });

  it("★ REFUSES a variant that isn't a real option for this product", async () => {
    // Validated against the SERVER's option list — a client-supplied id could
    // otherwise name another store's product entirely.
    seedOrder({ variants: [LARGE] });
    const res = await requestReturn(swapReq("v-someone-elses"));
    expect(res.error).toContain("isn't available");
    expect(holdStock).not.toHaveBeenCalled();
  });

  it("★ REFUSES a swap for something out of stock", async () => {
    // Offering it would be a promise the store can't keep, made when the
    // customer is already unhappy.
    seedOrder({ variants: [{ ...LARGE, stock: 0 }] });
    const res = await requestReturn(swapReq());
    expect(res.error).toContain("out of stock");
    expect(holdStock).not.toHaveBeenCalled();
  });

  it("allows an out-of-stock variant that's backorderable", async () => {
    seedOrder({ variants: [{ ...LARGE, stock: 0, allow_backorder: true }] });
    expect((await requestReturn(swapReq())).error).toBeUndefined();
  });

  it("★ refuses any swap when the store has exchanges off", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.allowExchanges": false }),
    );
    seedOrder({ variants: [LARGE] });
    const res = await requestReturn(swapReq());
    expect(res.error).toContain("doesn't offer exchanges");
  });

  it("holds nothing for a plain refund request", async () => {
    seedOrder({ variants: [LARGE] });
    const res = await requestReturn({
      orderId: "o1",
      lines: [{ orderItemId: "li-a", quantity: 1 }],
      reasonCode: "changed_mind",
    });
    expect(res.isExchange).toBe(false);
    expect(holdStock).not.toHaveBeenCalled();
  });
});

describe("exchange holds are given back when it won't happen", () => {
  function seedDecided() {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ hold: "hold-1" }],
        [{ order_ref: "ORD1", customer_id: "cust-1" }],
      ],
      returning: [
        {
          id: "ret-1",
          order_id: "o1",
          total: 210,
          restocking_fee: 0,
          return_shipping_fee: 0,
        },
      ],
    });
  }

  it("★ declining releases the replacement units", async () => {
    // Holding stock for an exchange that will never happen makes that size
    // unsellable to everyone else.
    seedDecided();
    await reviewReturn("ret-1", "reject", "Past the window.");
    expect(releaseHold).toHaveBeenCalledWith("hold-1");
  });

  it("approving does NOT release them", async () => {
    seedDecided();
    await reviewReturn("ret-1", "approve");
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it("withdrawing releases them", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ hold: "hold-1" }]],
      returning: [{ id: "ret-1", order_id: "o1" }],
    });
    await cancelMyReturn("ret-1");
    expect(releaseHold).toHaveBeenCalledWith("hold-1");
  });
});

describe("receiveReturn — the replacement order", () => {
  function seedExchangeReceipt() {
    dbHolder.current = makeDbMock({
      selectQueue: [
        // receiveReturn's own items
        [
          {
            id: "rri-1",
            order_item_id: "li-a",
            quantity: 1,
            product_id: "p1",
            variant_id: "v-m",
          },
        ],
        // createExchangeOrder: return items → original order → variant names
        [
          {
            id: "rri-1",
            quantity: 1,
            product_id: "p1",
            variant_id: "v-l",
            price: 100,
            hold_id: "hold-1",
            name: "Amul Taaza Toned Milk",
          },
        ],
        [
          {
            customer_id: "cust-1",
            shipping_address: {},
            billing_address: {},
            order_ref: "ORD1",
            currency: "INR",
          },
        ],
        [{ id: "v-l", name: "1 L" }],
        [{ order_ref: "ORD-NEW" }],
      ],
      returning: [{ id: "ret-1", order_id: "o1", location_id: null }],
    });
  }

  it("★ raises a replacement ORDER, not a third kind of thing", async () => {
    seedExchangeReceipt();
    const res = await receiveReturn("ret-1", []);

    expect(res.ok).toBe(true);
    // An ordinary orders row, so every existing reader picks it up.
    const orderRow = dbHolder.current.calls.values.find(
      (v: any) => v && !Array.isArray(v) && "paymentStatus" in v,
    );
    expect(orderRow).toMatchObject({
      paymentMethod: "exchange",
      paymentStatus: "paid",
      total: 100,
      // ★ Nothing to release on cancel: the units were HELD, and committing
      // the hold is the stock movement.
      stockStatus: "none",
    });
  });

  it("★ commits the hold against the new order — units leave the shelf ONCE", async () => {
    seedExchangeReceipt();
    await receiveReturn("ret-1", []);
    expect(commitHold).toHaveBeenCalledWith("hold-1", expect.any(String));
  });

  it("tells the customer their exchange is on its way", async () => {
    seedExchangeReceipt();
    await receiveReturn("ret-1", []);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.exchange_ready" }),
    );
  });

  it("raises nothing for a plain refund return", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "rri-1",
            order_item_id: "li-a",
            quantity: 1,
            product_id: "p1",
            variant_id: null,
          },
        ],
        // No swap targets on any line.
        [
          {
            id: "rri-1",
            quantity: 1,
            product_id: null,
            variant_id: null,
            price: null,
            hold_id: null,
            name: "Milk",
          },
        ],
      ],
      returning: [{ id: "ret-1", order_id: "o1", location_id: null }],
    });
    const res = await receiveReturn("ret-1", []);
    expect(res.exchangeOrderId).toBeUndefined();
    expect(commitHold).not.toHaveBeenCalled();
  });
});
