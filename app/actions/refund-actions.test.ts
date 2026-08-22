/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
  isStoreSuperadmin: vi.fn(async () => true),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/payments/provider", () => ({ getStoreGateway: vi.fn() }));
vi.mock("@/lib/payments/razorpay", () => ({
  rzpRefund: vi.fn(),
  rzpFetchOrderPayments: vi.fn(),
  capturedPayment: vi.fn(() => null),
}));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  reconcileOrderRefunds: vi.fn(async () => 0),
  syncOrderRefundState: vi.fn(async () => {}),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  getManagerIdentity,
  isStoreSuperadmin,
} from "@/app/dashboard/lib/access";
import { getStoreSettings } from "@/lib/settings/resolve";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { getStoreGateway } from "@/lib/payments/provider";
import { rzpRefund } from "@/lib/payments/razorpay";
import { syncOrderRefundState } from "@/lib/payments/refund-reconcile";
import { emitEvent } from "@/lib/notifications/record";
import { refundOrder } from "./refund-actions";

const ADMIN = { uid: "admin-1", email: "owner@shop.test" };

function settings(overrides: Record<string, boolean | number> = {}) {
  return { ...resolveStoreSettings(null, "pro"), ...overrides } as any;
}

const PAID_ONLINE = {
  id: "o1",
  store_id: "store-1",
  order_ref: "ORD10011027",
  customer_id: "cust-1",
  total: 840,
  payment_method: "razorpay",
  payment_status: "paid",
  razorpay_payment_id: "pay_123",
  razorpay_order_id: "order_123",
};

const COD = {
  ...PAID_ONLINE,
  payment_method: "cash_on_delivery",
  payment_status: "paid",
  razorpay_payment_id: null,
  razorpay_order_id: null,
};

/** The two selects refundOrder makes inside its transaction: the locked order
 *  row, then the refunds already recorded against it. */
function seed(order: any, existingRefunds: any[] = []) {
  dbHolder.current = makeDbMock({
    selectQueue: [[order], existingRefunds],
    returning: [{ id: "refund-1" }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getManagerIdentity as any).mockResolvedValue(ADMIN);
  (getStoreSettings as any).mockResolvedValue(settings());
  (isStoreSuperadmin as any).mockResolvedValue(true);
  (getStoreGateway as any).mockResolvedValue({
    creds: { keyId: "rzp_test", keySecret: "s" },
    enabled: true,
  });
  seed(PAID_ONLINE);
});

describe("refundOrder — gate and input", () => {
  it("refuses an unauthenticated caller", async () => {
    (getManagerIdentity as any).mockResolvedValue(null);
    expect(await refundOrder("o1", { method: "razorpay" })).toEqual({
      error: "Not authenticated",
    });
  });

  it("refuses an unknown method", async () => {
    const res = await refundOrder("o1", { method: "bitcoin" } as any);
    expect(res.error).toBeTruthy();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses a manual refund with no reference", async () => {
    // The reference is the only evidence a manual refund row will ever carry:
    // the money moved somewhere this system cannot see.
    const res = await refundOrder("o1", { method: "manual" });
    expect(res.error).toContain("reference");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses the gateway for an order that wasn't paid online", async () => {
    seed(COD);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("wasn't paid online");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("refuses a gateway refund on an unpaid order", async () => {
    seed({ ...PAID_ONLINE, payment_status: "pending" });
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("never paid");
    expect(rzpRefund).not.toHaveBeenCalled();
  });
});

describe("refundOrder — the amount is never the client's", () => {
  it("defaults to the whole order", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    await refundOrder("o1", { method: "razorpay" });
    expect(dbHolder.current.calls.values[0].amount).toBe(840);
  });

  it("refuses more than remains after an earlier refund", async () => {
    seed(PAID_ONLINE, [{ amount: 600, status: "completed" }]);
    const res = await refundOrder("o1", { method: "razorpay", amount: 500 });
    expect(res.error).toContain("240.00");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ counts a PENDING refund against the cap", async () => {
    // Otherwise a timed-out refund's money can be handed back a second time
    // while the first is still in flight.
    seed(PAID_ONLINE, [{ amount: 840, status: "pending" }]);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("already been fully refunded");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ locks the order row FOR UPDATE", async () => {
    // Two admins clicking Refund at the same moment must serialise here; both
    // would otherwise read the same refundable amount and both pass the cap.
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    await refundOrder("o1", { method: "razorpay" });
    expect(dbHolder.current.calls.forUpdate).toContain("update");
  });
});

describe("refundOrder — the row is written before the money moves", () => {
  it("★ inserts a PENDING row carrying an idempotency key, then calls the gateway with it", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    await refundOrder("o1", { method: "razorpay" });

    const row = dbHolder.current.calls.values[0];
    expect(row.status).toBe("pending");
    expect(row.idempotencyKey).toEqual(expect.any(String));
    expect(row.idempotencyKey.length).toBeGreaterThan(10);

    // The SAME key reaches Razorpay — that is what makes a retry safe and
    // what reconcile later looks the refund up by.
    expect(rzpRefund).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: "pay_123",
        amountPaise: 84000,
        idempotencyKey: row.idempotencyKey,
      }),
    );
  });

  it("marks the row completed and syncs the order when Razorpay processes it", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    const res = await refundOrder("o1", { method: "razorpay" });

    expect(res.status).toBe("completed");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "completed",
      gatewayRefundId: "rfnd_1",
    });
    expect(syncOrderRefundState).toHaveBeenCalledWith("o1");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.refund_issued" }),
    );
    // ★ The payload must name the amount `amount` and carry the method.
    // `total` is not a declared variable for this event, so templateValues
    // drops it and the customer's refund email goes out with no figure; the
    // method is what stops the copy claiming their card was credited.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          amount: expect.any(Number),
          paymentMethod: expect.anything(),
        }),
      }),
    );
    const emitted = vi.mocked(emitEvent).mock.calls.at(-1)![0] as {
      payload: Record<string, unknown>;
    };
    expect(emitted.payload).not.toHaveProperty("total");
  });

  it("stays pending when Razorpay accepts it but hasn't settled", async () => {
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "pending" },
    });
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.pendingReconcile).toBe(true);
    expect(syncOrderRefundState).not.toHaveBeenCalled();
  });
});

describe("refundOrder — a timeout is not a failure", () => {
  it("★ leaves the row PENDING and reports no error on an unknown outcome", async () => {
    // The single most important behaviour here. A 5xx or a network timeout may
    // mean the refund WAS created. Failing the row would free the amount and
    // invite a second refund of money already on its way to the customer.
    (rzpRefund as any).mockResolvedValue({
      ok: false,
      error: "socket hang up",
      outcome: "unknown",
    });
    const res = await refundOrder("o1", { method: "razorpay" });

    expect(res.error).toBeUndefined();
    expect(res.status).toBe("pending");
    expect(res.pendingReconcile).toBe(true);
    // Nothing was marked failed — reconcile will find out from the gateway.
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ marks the row FAILED on a rejection, so the amount is freed", async () => {
    // A 4xx IS a verdict: nothing happened, so the money must become
    // refundable again rather than being stranded in a pending row forever.
    (rzpRefund as any).mockResolvedValue({
      ok: false,
      error: "The amount is more than the refundable amount.",
      outcome: "rejected",
    });
    const res = await refundOrder("o1", { method: "razorpay" });

    expect(res.error).toContain("refundable");
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "failed" });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("fails the row when the gateway was disconnected mid-flight", async () => {
    (getStoreGateway as any).mockResolvedValue(null);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("Channels");
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "failed" });
    expect(rzpRefund).not.toHaveBeenCalled();
  });
});

describe("refundOrder — manual (the COD answer)", () => {
  it("records a completed refund without calling any gateway", async () => {
    seed(COD);
    const res = await refundOrder("o1", {
      method: "manual",
      reference: "UPI-9931XX",
      reason: "Damaged on arrival",
    });

    expect(res.status).toBe("completed");
    expect(rzpRefund).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      method: "manual",
      status: "completed",
      reference: "UPI-9931XX",
      reason: "Damaged on arrival",
      amount: 840,
    });
    expect(syncOrderRefundState).toHaveBeenCalledWith("o1");
  });

  it("still enforces the cap", async () => {
    seed(COD, [{ amount: 840, status: "completed" }]);
    const res = await refundOrder("o1", {
      method: "manual",
      reference: "UPI-1",
    });
    expect(res.error).toContain("already been fully refunded");
  });

  it("is allowed on an ONLINE order too — the merchant may have paid by hand", async () => {
    const res = await refundOrder("o1", {
      method: "manual",
      reference: "NEFT-77",
    });
    expect(res.status).toBe("completed");
    expect(rzpRefund).not.toHaveBeenCalled();
  });
});

describe("refundOrder — who may give money back", () => {
  it("★ owner-only blocks a delegated orders manager", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.ownerOnlyRefunds": true }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);

    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("owner");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("owner-only still lets the owner through", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.ownerOnlyRefunds": true }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(true);
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    expect((await refundOrder("o1", { method: "razorpay" })).status).toBe(
      "completed",
    );
  });

  it("lets a manager refund UNDER the approval cap", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.maxRefundWithoutApproval": 500 }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);
    (rzpRefund as any).mockResolvedValue({
      ok: true,
      data: { id: "rfnd_1", status: "processed" },
    });
    const res = await refundOrder("o1", { method: "razorpay", amount: 200 });
    expect(res.status).toBe("completed");
  });

  it("blocks a manager OVER the approval cap", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.maxRefundWithoutApproval": 500 }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);
    const res = await refundOrder("o1", { method: "razorpay", amount: 600 });
    expect(res.error).toContain("owner");
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ the cap can't be dodged by leaving the amount blank", async () => {
    // Blank means "refund everything left" — ₹840 here, well over the cap.
    // Checking only `input.amount` would let anyone past by not typing a
    // number, which is why the cap is re-checked once the amount resolves.
    (getStoreSettings as any).mockResolvedValue(
      settings({ "returns.maxRefundWithoutApproval": 500 }),
    );
    (isStoreSuperadmin as any).mockResolvedValue(false);
    const res = await refundOrder("o1", { method: "razorpay" });
    expect(res.error).toContain("owner");
    expect(rzpRefund).not.toHaveBeenCalled();
  });
});
