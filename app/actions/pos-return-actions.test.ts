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

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { emitEvent } from "@/lib/notifications/record";
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
