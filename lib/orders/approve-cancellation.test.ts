/* eslint-disable @typescript-eslint/no-explicit-any */
// The cancellation coordinator: status, inventory choice, money, notification.
//
// The financial invariant here is that "do not restock" controls GOODS only.
// Store credit and pickup holds still have to be released, so cancellation
// cleanup must run on both sides of that choice.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

vi.mock("@/lib/orders/cancel", () => ({
  releaseCancelledOrder: vi.fn(async () => undefined),
}));
vi.mock("@/lib/payments/issue-refund", () => ({
  issueRefund: vi.fn(async () => ({
    refundId: "rf-1",
    status: "completed",
    amount: 500,
  })),
}));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  refundDueForOrder: vi.fn(async () => 0),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { releaseCancelledOrder } from "@/lib/orders/cancel";
import { issueRefund } from "@/lib/payments/issue-refund";
import { approveCancellation } from "./approve-cancellation";

const CLAIMED = {
  id: "order-1",
  order_ref: "ORD1001",
  total: 500,
  payment_status: "paid",
  payment_method: "razorpay",
  customer_id: "customer-1",
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    storeId: "store-1",
    orderId: "order-1",
    actorId: "admin-1",
    actorLabel: "owner@example.test",
    refundDestination: "original" as const,
    reasonCode: "customer_changed_mind",
    restock: true,
    notify: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ returning: [CLAIMED] });
  vi.mocked(issueRefund).mockResolvedValue({
    refundId: "rf-1",
    status: "completed",
    amount: 500,
  });
});

describe("approveCancellation", () => {
  it("★★ runs financial and hold cleanup even when stock must not be restocked", async () => {
    const res = await approveCancellation(input({ restock: false }));
    expect(res.success).toBe(true);
    expect(releaseCancelledOrder).toHaveBeenCalledWith(
      "store-1",
      "order-1",
      expect.any(Function),
      "order_cancelled",
      { restock: false },
    );
  });

  it("routes original-method cancellation refunds through Razorpay", async () => {
    await approveCancellation(input());
    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        orderId: "order-1",
        customerId: "customer-1",
        method: "razorpay",
      }),
    );
  });

  it("keeps an unknown gateway outcome pending instead of inviting a retry", async () => {
    vi.mocked(issueRefund).mockResolvedValue({
      refundId: "rf-1",
      status: "pending",
      amount: 500,
      pendingReconcile: true,
    });
    const res = await approveCancellation(input());
    expect(res.refundPending).toBe(true);
    expect(res.refundError).toBeUndefined();
  });

  it("reports a definitive refund failure separately from the cancellation", async () => {
    vi.mocked(issueRefund).mockResolvedValue({ error: "balance too low" });
    const res = await approveCancellation(input());
    expect(res.success).toBe(true);
    expect(res.refundError).toBe("balance too low");
  });
});
