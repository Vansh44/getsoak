import { describe, it, expect } from "vitest";
import {
  checkRefundAmount,
  mapGatewayRefundStatus,
  matchGatewayRefund,
  refundableAmount,
} from "./refunds";

describe("refundableAmount", () => {
  it("is the whole order when nothing has gone back", () => {
    expect(refundableAmount({ orderTotal: 840, refunds: [] })).toBe(840);
  });

  it("subtracts completed refunds", () => {
    expect(
      refundableAmount({
        orderTotal: 840,
        refunds: [{ amount: 200, status: "completed" }],
      }),
    ).toBe(640);
  });

  it("★ counts PENDING refunds against the cap", () => {
    // The one that matters. A refund in flight has not settled but may yet —
    // ignoring it lets a second refund be raised for the same money while the
    // first is still on its way, and together they over-refund the order.
    expect(
      refundableAmount({
        orderTotal: 840,
        refunds: [{ amount: 840, status: "pending" }],
      }),
    ).toBe(0);
  });

  it("frees the amount again when a refund FAILED", () => {
    expect(
      refundableAmount({
        orderTotal: 840,
        refunds: [
          { amount: 840, status: "failed" },
          { amount: 100, status: "completed" },
        ],
      }),
    ).toBe(740);
  });

  it("never goes negative, even if the data says it should", () => {
    expect(
      refundableAmount({
        orderTotal: 100,
        refunds: [{ amount: 250, status: "completed" }],
      }),
    ).toBe(0);
  });

  it("★ sums in paise, so repeated small refunds don't drift", () => {
    // 3 × 0.1 is 0.30000000000000004 in float rupees; if the cap were computed
    // that way, refunding the last ₹0.10 of a ₹0.30 order would be refused.
    const refunds = [
      { amount: 0.1, status: "completed" },
      { amount: 0.1, status: "completed" },
    ];
    expect(refundableAmount({ orderTotal: 0.3, refunds })).toBe(0.1);
  });
});

describe("checkRefundAmount", () => {
  it("defaults to the whole refundable amount", () => {
    expect(checkRefundAmount(undefined, 840)).toEqual({ amount: 840 });
  });

  it("accepts a partial amount", () => {
    expect(checkRefundAmount(200, 840)).toEqual({ amount: 200 });
  });

  it("accepts exactly the cap", () => {
    expect(checkRefundAmount(840, 840)).toEqual({ amount: 840 });
  });

  it("refuses more than remains, and says how much is left", () => {
    const res = checkRefundAmount(900, 840);
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("840.00");
  });

  it("refuses zero and negative amounts", () => {
    expect(checkRefundAmount(0, 840)).toHaveProperty("error");
    expect(checkRefundAmount(-50, 840)).toHaveProperty("error");
  });

  it("refuses anything when the order is already fully refunded", () => {
    expect(checkRefundAmount(undefined, 0)).toHaveProperty("error");
    expect(checkRefundAmount(10, 0)).toHaveProperty("error");
  });

  it("refuses a non-finite amount rather than passing NaN to the gateway", () => {
    expect(checkRefundAmount(Number.NaN, 840)).toHaveProperty("error");
    expect(checkRefundAmount(Number.POSITIVE_INFINITY, 840)).toHaveProperty(
      "error",
    );
  });
});

describe("mapGatewayRefundStatus", () => {
  it("maps Razorpay's states", () => {
    expect(mapGatewayRefundStatus("processed")).toBe("completed");
    expect(mapGatewayRefundStatus("failed")).toBe("failed");
    expect(mapGatewayRefundStatus("pending")).toBe("pending");
  });

  it("★ treats an UNKNOWN state as still in flight, never as settled", () => {
    // Guessing "completed" would close a refund that may yet fail, and free
    // nothing; guessing "failed" would free the amount for a second payout of
    // money already on its way. Staying pending means we ask again.
    expect(mapGatewayRefundStatus("some_new_state")).toBe("pending");
    expect(mapGatewayRefundStatus("")).toBe("pending");
  });
});

describe("matchGatewayRefund", () => {
  const refunds = [
    { id: "rfnd_1", notes: { sm_refund_key: "key-a" } },
    { id: "rfnd_2", notes: { sm_refund_key: "key-b" } },
  ];

  it("finds our refund by the key we planted", () => {
    expect(matchGatewayRefund(refunds, "key-b")?.id).toBe("rfnd_2");
  });

  it("returns null when the gateway has nothing of ours", () => {
    expect(matchGatewayRefund(refunds, "key-c")).toBeNull();
    expect(matchGatewayRefund([], "key-a")).toBeNull();
  });

  it("★ never matches on an empty key", () => {
    // A row with no idempotency key (a legacy till refund) must not silently
    // adopt the first gateway refund it sees.
    expect(
      matchGatewayRefund([{ id: "r", notes: {} }] as never[], ""),
    ).toBeNull();
  });

  it("tolerates refunds with no notes at all", () => {
    expect(matchGatewayRefund([{ id: "r", notes: null }], "key-a")).toBeNull();
  });
});

describe("★ a money refund can't exceed what money actually paid", () => {
  // ₹500 of goods, ₹200 settled with store credit, ₹300 charged to a card.
  // `orders.total` stays 500 by design (credit is a payment, not a discount —
  // §29), so a cap of `total` hands back ₹200 the store never took. Razorpay
  // would refuse it; cash and manual have no such backstop.
  const order = { orderTotal: 500, storeCreditUsed: 200 };

  it("caps a cash refund at the ₹300 that was charged", () => {
    expect(refundableAmount({ ...order, refunds: [], method: "cash" })).toBe(
      300,
    );
    expect(refundableAmount({ ...order, refunds: [], method: "manual" })).toBe(
      300,
    );
    expect(
      refundableAmount({ ...order, refunds: [], method: "razorpay" }),
    ).toBe(300);
  });

  it("does NOT cap a refund made as store credit", () => {
    // Giving a balance back for a balance costs the store nothing it didn't
    // already owe, so the whole goods value is available that way.
    expect(
      refundableAmount({ ...order, refunds: [], method: "store_credit" }),
    ).toBe(500);
  });

  it("a credit refund doesn't eat the money headroom", () => {
    const after = refundableAmount({
      ...order,
      refunds: [{ amount: 200, status: "completed", method: "store_credit" }],
      method: "cash",
    });
    expect(after).toBe(300);
  });

  it("a money refund does eat it", () => {
    const after = refundableAmount({
      ...order,
      refunds: [{ amount: 100, status: "completed", method: "manual" }],
      method: "cash",
    });
    expect(after).toBe(200);
  });

  it("never exceeds the overall cap either", () => {
    // ₹450 already back as credit leaves ₹50 overall, even though ₹300 of
    // money was charged.
    const after = refundableAmount({
      ...order,
      refunds: [{ amount: 450, status: "completed", method: "store_credit" }],
      method: "cash",
    });
    expect(after).toBe(50);
  });

  it("behaves exactly as before when no credit was used", () => {
    expect(
      refundableAmount({ orderTotal: 500, refunds: [], method: "cash" }),
    ).toBe(500);
    expect(refundableAmount({ orderTotal: 500, refunds: [] })).toBe(500);
  });
});
