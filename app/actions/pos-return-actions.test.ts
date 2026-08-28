/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/pos/customer-verification", () => ({
  hasCustomerVerification: vi.fn(async () => true),
  clearCustomerVerification: vi.fn(async () => undefined),
}));
vi.mock("./pos-shift-actions", () => ({
  currentShiftIdFor: vi.fn(async () => "shift-1"),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/inventory/alerts", () => ({ reportStockChanges: vi.fn() }));
vi.mock("@/lib/payments/issue-refund", () => ({
  issueRefund: vi.fn(async () => ({ refundId: "rf-1", status: "completed" })),
}));
vi.mock("@/lib/returns/counter-policy", () => ({
  getCounterReturnPolicy: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { emitEvent } from "@/lib/notifications/record";
import { issueRefund } from "@/lib/payments/issue-refund";
import {
  findOrderForReturn,
  getReturnableSale,
  processReturn,
} from "./pos-return-actions";
import { hasCustomerVerification } from "@/lib/pos/customer-verification";
import { getCounterReturnPolicy } from "@/lib/returns/counter-policy";

const MANAGER = {
  role: "manager" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};
const CASHIER = { ...MANAGER, role: "cashier" as const };

/** A sale of 2 × ₹100 (tax ₹10) and 1 × ₹50 (tax ₹2.50), no order discount. */
function seedSale(
  opts: {
    prior?: { order_item_id: string; qty: number }[];
    /** Refunds already recorded, which the in-transaction cap reads. */
    existingRefunds?: { amount: number; status: string; method: string }[];
    storeCreditUsed?: number;
    paymentRows?: Array<{
      method: string;
      amount: number;
      change_due: number | null;
      reference: string | null;
    }>;
    productReturnable?: boolean;
  } = {},
) {
  const order = {
    id: "o1",
    receipt_no: "POS-000007",
    order_ref: "ORD1",
    created_at: "2026-07-30T10:00:00Z",
    total: 262.5,
    discount: 0,
    store_credit_used: opts.storeCreditUsed ?? 0,
    payment_method: "cash",
    payment_status: "paid",
    // Rung at THIS register — it avoids the additional BORIS gates, but still
    // follows the store's master returns policy.
    location_id: "loc-1",
    sales_channel: "pos",
    status: "completed",
    delivered_at: null,
    collected_at: null,
  };
  const items = [
    {
      id: "li-a",
      product_id: "p1",
      variant_id: null,
      name: "Milk",
      variant_name: null,
      quantity: 2,
      price: 100,
      total: 200,
      line_discount: 0,
      tax_amount: 10,
      product_returnable: opts.productReturnable ?? true,
      product_window: null,
    },
    {
      id: "li-b",
      product_id: "p2",
      variant_id: null,
      name: "Salt",
      variant_name: null,
      quantity: 1,
      price: 50,
      total: 50,
      line_discount: 0,
      tax_amount: 2.5,
      product_returnable: true,
      product_window: null,
    },
  ];
  const prior = opts.prior ?? [];
  dbHolder.current = makeDbMock({
    selectQueue: [
      // getReturnableSale
      [order],
      items,
      prior,
      opts.paymentRows ?? [],
      // processReturn's write transaction: FOR UPDATE lock → items → prior
      // → refunds already recorded (the money cap).
      [order],
      items,
      prior,
      opts.existingRefunds ?? [],
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(MANAGER as any);
  vi.mocked(hasCustomerVerification).mockResolvedValue(true);
  vi.mocked(getCounterReturnPolicy).mockResolvedValue({
    enabled: true,
    allowInStore: true,
    allowExchanges: true,
    requireReason: false,
    windowDays: 365,
    restockingFeePercent: 0,
    locationAccepts: true,
  });
  seedSale();
});

describe("getReturnableSale", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await getReturnableSale("o1")).error).toMatch(/signed in/i);
  });

  it("★ a cashier cannot take returns — refunding is a manager capability", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    expect((await getReturnableSale("o1")).error).toMatch(/permission/i);
  });

  it("reports what is still returnable", async () => {
    const { sale } = await getReturnableSale("o1");
    expect(sale?.lines.map((l) => [l.id, l.remaining])).toEqual([
      ["li-a", 2],
      ["li-b", 1],
    ]);
  });

  it("★ subtracts what earlier returns already took back", async () => {
    seedSale({ prior: [{ order_item_id: "li-a", qty: 1 }] });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.lines[0]).toMatchObject({ returned: 1, remaining: 1 });
  });

  it("★ scopes to the operator's own shop", async () => {
    await getReturnableSale("o1");
    // store AND location equality, alongside the order id.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("applies the merchant master switch to a sale rung at this counter", async () => {
    vi.mocked(getCounterReturnPolicy).mockResolvedValue({
      enabled: false,
      allowInStore: false,
      allowExchanges: false,
      requireReason: true,
      windowDays: 7,
      restockingFeePercent: 0,
      locationAccepts: false,
    });
    expect((await getReturnableSale("o1")).error).toMatch(
      /returns are switched off/i,
    );
  });

  it("marks a final-sale product ineligible at the till", async () => {
    seedSale({ productReturnable: false });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.lines[0]).toMatchObject({
      eligible: false,
      blockedCopy: expect.stringMatching(/final sale/i),
    });
  });

  it("reads split tender rows instead of offering an arbitrary cash refund", async () => {
    seedSale({
      paymentRows: [
        { method: "cash", amount: 62.5, change_due: 0, reference: null },
        { method: "card", amount: 200, change_due: null, reference: "T-1" },
      ],
    });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute).toMatchObject({
      method: "original",
      counterChoice: false,
    });
    expect(sale?.refundTenders.map((tender) => tender.method)).toEqual([
      "cash",
      "card",
    ]);
  });
});

describe("findOrderForReturn", () => {
  it("returns a customer-linked POS receipt found by the submitted phone", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            order_ref: "ORD1",
            receipt_no: "POS-000007",
            created_at: "2026-08-29T10:00:00Z",
            total: 262.5,
            payment_method: "cash",
            location_id: "loc-1",
            sales_channel: "pos",
          },
        ],
      ],
    });

    const result = await findOrderForReturn("9814");

    expect(result).toEqual({
      results: [
        expect.objectContaining({
          orderId: "o1",
          label: "ORD1",
          broughtIn: false,
        }),
      ],
    });
    expect(dbHolder.current.calls.leftJoin).toHaveLength(1);
  });
});

describe("processReturn", () => {
  it("requires the server-bound customer OTP proof before loading refund details", async () => {
    vi.mocked(hasCustomerVerification).mockResolvedValue(false);
    const result = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(result).toMatchObject({ verificationRequired: true });
    expect(result.error).toMatch(/verify.*mobile/i);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toMatch(/permission/i);
  });

  it("refuses an unknown refund method", async () => {
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "gift_card" as never,
    );
    expect(r.error).toMatch(/how the money goes back/i);
  });

  it("refuses an empty return", async () => {
    expect((await processReturn("o1", [], "cash")).error).toMatch(
      /what's coming back/i,
    );
  });

  it("requires a reason when the merchant setting does", async () => {
    vi.mocked(getCounterReturnPolicy).mockResolvedValue({
      enabled: true,
      allowInStore: true,
      allowExchanges: true,
      requireReason: true,
      windowDays: 365,
      restockingFeePercent: 0,
      locationAccepts: true,
    });
    const result = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(result.error).toMatch(/choose why/i);
  });

  it("allocates a split refund over its original tenders", async () => {
    seedSale({
      paymentRows: [
        { method: "cash", amount: 62.5, change_due: 0, reference: null },
        { method: "card", amount: 200, change_due: null, reference: "T-1" },
      ],
    });
    const result = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "original",
    );
    expect(result.error).toBeUndefined();
    expect(
      vi.mocked(issueRefund).mock.calls.map(([input]) => input.method),
    ).toEqual(["cash", "card"]);
    expect(
      vi
        .mocked(issueRefund)
        .mock.calls.reduce((sum, [input]) => sum + Number(input.amount), 0),
    ).toBe(105);
  });

  it("★ recomputes the amount server-side — a line quantity beyond what remains is clamped", async () => {
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 99 }],
      "cash",
    );
    // 2 units only: 200 + 10 tax.
    expect(r.refunded).toBe(210);
  });

  it("refuses when nothing on the sale is still returnable", async () => {
    seedSale({
      prior: [
        { order_item_id: "li-a", qty: 2 },
        { order_item_id: "li-b", qty: 1 },
      ],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(r.error).toMatch(/still returnable/i);
  });

  it("emits order.refund_issued with what actually went back", async () => {
    await processReturn("o1", [{ orderItemId: "li-b", quantity: 1 }], "cash");
    // ★ `amount`, not `total`. The catalog declares `amount` for this event and
    // templateValues drops anything undeclared, so `total` meant the customer's
    // refund email carried no figure at all. `paymentMethod` is what keeps the
    // copy from claiming a card was credited when it wasn't.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.refund_issued",
        payload: expect.objectContaining({
          amount: 52.5,
          paymentMethod: "cash",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// BORIS — returning an ONLINE order at a counter (roadmap Step 5)
// ---------------------------------------------------------------------------

/** An order that was NOT rung at this register. */
function seedBroughtIn(opts: {
  paymentMethod?: string;
  storeAllows?: boolean;
  locationAccepts?: boolean;
  locationId?: string | null;
}) {
  const {
    paymentMethod = "razorpay",
    storeAllows = true,
    locationAccepts = true,
    locationId = null,
  } = opts;
  const order = {
    id: "o1",
    receipt_no: null,
    order_ref: "ORD10011027",
    created_at: "2026-07-30T10:00:00Z",
    total: 210,
    discount: 0,
    store_credit_used: 0,
    payment_method: paymentMethod,
    payment_status: "paid",
    // Online is always a brought-in return, even if it was fulfilled by this
    // same shop for pickup.
    location_id: locationId,
    sales_channel: "online",
    status: "delivered",
    delivered_at: "2026-08-28T10:00:00Z",
    collected_at: null,
  };
  const items = [
    {
      id: "li-a",
      product_id: "p1",
      variant_id: null,
      name: "Milk",
      variant_name: null,
      quantity: 2,
      price: 100,
      total: 200,
      line_discount: 0,
      tax_amount: 10,
      product_returnable: true,
      product_window: null,
    },
  ];
  vi.mocked(getCounterReturnPolicy).mockResolvedValue({
    enabled: true,
    allowInStore: storeAllows,
    allowExchanges: true,
    requireReason: false,
    windowDays: 365,
    restockingFeePercent: 0,
    locationAccepts,
  });
  dbHolder.current = makeDbMock({
    selectQueue: [
      [order],
      items,
      [], // prior returns
      [], // original tender rows; payment_method is the legacy source
      [order],
      items,
      [],
      [], // existing refunds
    ],
    returning: [{ id: "ret-1" }],
  });
}

describe("BORIS — an order this counter didn't sell", () => {
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(MANAGER as any);
  });

  it("★ is FOUND at all — the lookup is store-scoped, not location-scoped", async () => {
    // The old `location_id = op.locationId` predicate could never match an
    // online order, so BORIS found nothing whatsoever.
    seedBroughtIn({});
    const { sale, error } = await getReturnableSale("o1");
    expect(error).toBeUndefined();
    expect(sale?.broughtIn).toBe(true);
  });

  it("treats an online pickup from this same shop as an in-store return", async () => {
    seedBroughtIn({ locationId: "loc-1", storeAllows: false });
    const { sale, error } = await getReturnableSale("o1");
    expect(sale).toBeUndefined();
    expect(error).toContain("only take back");
  });

  it("★ routes an online order's refund to the GATEWAY, with no counter choice", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute.method).toBe("razorpay");
    expect(sale?.refundRoute.counterChoice).toBe(false);
    expect(sale?.refundRoute.affectsDrawer).toBe(false);
  });

  it("offers the counter tenders for a COD order", async () => {
    seedBroughtIn({ paymentMethod: "cash_on_delivery" });
    const { sale } = await getReturnableSale("o1");
    expect(sale?.refundRoute.counterChoice).toBe(true);
    expect(sale?.refundRoute.affectsDrawer).toBe(true);
  });

  it("★ is refused when the store hasn't enabled in-store returns", async () => {
    seedBroughtIn({ storeAllows: false });
    const { sale, error } = await getReturnableSale("o1");
    expect(sale).toBeUndefined();
    expect(error).toContain("only take back");
  });

  it("★ is refused when THIS location lacks the returns capability", async () => {
    seedBroughtIn({ locationAccepts: false });
    const { error } = await getReturnableSale("o1");
    expect(error).toContain("Locations");
  });

  it("★ REFUSES cash for a card order, even called directly", async () => {
    // The till hides the option; this is the server saying no anyway. Cash
    // back for a card sale is the card-not-present laundering path.
    seedBroughtIn({ paymentMethod: "razorpay" });
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "cash",
    );
    expect(res.error).toContain("original source");
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("★ sends a card order's refund through the shared core, with NO shift", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(res.error).toBeUndefined();
    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", method: "razorpay" }),
    );
    // A gateway refund never touches the drawer — stamping a shift would make
    // the cash report count money that never left the till.
    const call = vi.mocked(issueRefund).mock.calls[0][0] as any;
    expect(call.shiftId).toBeNull();
    expect(call.locationId).toBeNull();
  });

  it("★ keeps the return when the gateway refund fails — the goods ARE back", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    vi.mocked(issueRefund).mockResolvedValueOnce({
      error: "Razorpay isn't connected.",
      code: "gateway_not_connected",
    } as any);
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    // NOT an error: the customer handed the items over and walked away.
    expect(res.error).toBeUndefined();
    expect(res.returnId).toBeTruthy();
    expect(res.note).toContain("couldn't be sent");
  });

  it("warns without inviting a retry when the gateway hasn't confirmed", async () => {
    seedBroughtIn({ paymentMethod: "razorpay" });
    vi.mocked(issueRefund).mockResolvedValueOnce({
      refundId: "rf-1",
      status: "pending",
      pendingReconcile: true,
    } as any);
    const res = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 1 }],
      "razorpay",
    );
    expect(res.note).toContain("Do not send it a second time");
  });
});

describe("★ the drawer is capped, not just the goods", () => {
  it("takes a row lock before pricing", async () => {
    // getReturnableSale answered "what may come back" outside any
    // transaction. Two counters — or one double-tapped Confirm — both read it
    // before either wrote: proven on staging as ₹158 refunded against a ₹79
    // sale. The gateway path was safe because issueRefund takes this lock;
    // the cash path wrote its refund row directly and had nothing.
    seedSale();
    await processReturn("o1", [{ orderItemId: "li-a", quantity: 1 }], "cash");
    expect(dbHolder.current.calls.forUpdate).toContain("update");
  });

  it("★ refuses a cash refund beyond what the sale can still give back", async () => {
    // ₹262.50 sale with ₹250 already refunded. The quantity clamp is happy —
    // the goods are still on the order — but the money is not there.
    seedSale({
      existingRefunds: [{ amount: 250, status: "completed", method: "cash" }],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
    );
    expect(r.error).toMatch(/at most ₹12\.50/);
    expect(r.returnId).toBeUndefined();
  });

  it("says so plainly when nothing is left", async () => {
    seedSale({
      existingRefunds: [{ amount: 262.5, status: "completed", method: "cash" }],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-b", quantity: 1 }],
      "cash",
    );
    expect(r.error).toMatch(/already been fully refunded/i);
  });

  it("a FAILED refund frees its amount again", async () => {
    seedSale({
      existingRefunds: [{ amount: 250, status: "failed", method: "cash" }],
    });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
    );
    expect(r.error).toBeUndefined();
  });

  it("★ won't hand back cash for the part settled with store credit", async () => {
    // ₹262.50 of goods, ₹200 of it paid with credit ⇒ only ₹62.50 of money
    // ever arrived, and that is all the drawer may return.
    seedSale({ storeCreditUsed: 200 });
    const r = await processReturn(
      "o1",
      [{ orderItemId: "li-a", quantity: 2 }],
      "cash",
    );
    expect(r.error).toMatch(/at most ₹62\.50/);
  });

  it("★ can't be multiplied by naming the same line twice", async () => {
    seedSale();
    const r = await processReturn(
      "o1",
      [
        { orderItemId: "li-b", quantity: 1 },
        { orderItemId: "li-b", quantity: 1 },
        { orderItemId: "li-b", quantity: 1 },
      ],
      "cash",
    );
    expect(r.error).toBeUndefined();
    // ₹50 + ₹2.50 tax, once — not three times.
    expect(r.refunded).toBe(52.5);
  });
});
