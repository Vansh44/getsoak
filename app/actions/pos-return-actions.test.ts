/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("./pos-shift-actions", () => ({
  currentShiftIdFor: vi.fn(async () => "shift-1"),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/inventory/alerts", () => ({ reportStockChanges: vi.fn() }));
vi.mock("@/lib/payments/issue-refund", () => ({
  issueRefund: vi.fn(async () => ({ refundId: "rf-1", status: "completed" })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { emitEvent } from "@/lib/notifications/record";
import { issueRefund } from "@/lib/payments/issue-refund";
import { getReturnableSale, processReturn } from "./pos-return-actions";

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
  opts: { prior?: { order_item_id: string; qty: number }[] } = {},
) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          id: "o1",
          receipt_no: "POS-000007",
          order_ref: "ORD1",
          created_at: "2026-07-30T10:00:00Z",
          total: 262.5,
          discount: 0,
          payment_method: "cash",
          payment_status: "paid",
          // Rung at THIS register — the ordinary till case, which stays
          // returnable here regardless of the BORIS settings.
          location_id: "loc-1",
          sales_channel: "pos",
        },
      ],
      [
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
        },
      ],
      opts.prior ?? [],
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(MANAGER as any);
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
});

describe("processReturn", () => {
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
    await processReturn("o1", [{ orderItemId: "li-b", quantity: 1 }], "upi");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.refund_issued",
        payload: expect.objectContaining({ total: 52.5, paymentMethod: "upi" }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// BORIS — returning an ONLINE order at a counter (roadmap Step 5)
// ---------------------------------------------------------------------------

/**
 * An order that was NOT rung at this register. `borisGates` runs two extra
 * selects (the store, then the location) before the sale is returned.
 */
function seedBroughtIn(opts: {
  paymentMethod?: string;
  storeAllows?: boolean;
  locationAccepts?: boolean;
}) {
  const {
    paymentMethod = "razorpay",
    storeAllows = true,
    locationAccepts = true,
  } = opts;
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          id: "o1",
          receipt_no: null,
          order_ref: "ORD10011027",
          created_at: "2026-07-30T10:00:00Z",
          total: 210,
          discount: 0,
          payment_method: paymentMethod,
          payment_status: "paid",
          // Fulfilled elsewhere — or online, where it's null.
          location_id: null,
          sales_channel: "online",
        },
      ],
      [
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
        },
      ],
      [], // prior returns
      // borisGates: store, then location
      [
        {
          settings: {
            features: {
              "returns.enabled": storeAllows,
              "returns.allowInStore": storeAllows,
            },
          },
          plan: "pro",
          plan_expires_at: null,
        },
      ],
      [
        {
          capabilities: locationAccepts
            ? { pos: true, returns: true }
            : { pos: true, returns: false },
          type: "shop",
        },
      ],
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
    expect(res.error).toContain("go back the same way");
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
    expect(call.shiftId).toBeUndefined();
    expect(call.locationId).toBeUndefined();
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
    expect(res.note).toContain("don't send it again");
  });
});
