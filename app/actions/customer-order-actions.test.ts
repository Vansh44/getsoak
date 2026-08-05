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
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/orders/cancel", () => ({ releaseCancelledOrder: vi.fn() }));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  refundDueForOrder: vi.fn(async () => 0),
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
import { rateLimit } from "@/lib/rate-limit";
import { emitEvent } from "@/lib/notifications/record";
import { releaseCancelledOrder } from "@/lib/orders/cancel";
import { refundDueForOrder } from "@/lib/payments/refund-reconcile";
import { cancelMyOrder } from "./customer-order-actions";

const USER = { id: "cust-1", email: "ada@example.test" };
const HOUR = 3_600_000;

function settings(overrides: Record<string, boolean | number> = {}) {
  return {
    ...resolveStoreSettings(null, "pro"),
    "orders.allowCustomerCancellation": true,
    "orders.cancellationWindowHours": 24,
    ...overrides,
  } as any;
}

/** An order the shopper owns, placed `agoHours` ago. */
function seedOrder(over: Record<string, unknown> = {}, agoHours = 1) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [
        {
          id: "o1",
          order_ref: "ORD10011027",
          status: "pending",
          payment_status: "paid",
          total: 840,
          created_at: new Date(Date.now() - agoHours * HOUR).toISOString(),
          collected_at: null,
          ...over,
        },
      ],
    ],
    returning: [{ id: "o1" }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getServerUser as any).mockResolvedValue(USER);
  (getStoreSettings as any).mockResolvedValue(settings());
  (rateLimit as any).mockResolvedValue({ allowed: true });
  (refundDueForOrder as any).mockResolvedValue(0);
  seedOrder();
});

describe("cancelMyOrder — gates", () => {
  it("refuses an anonymous caller", async () => {
    (getServerUser as any).mockResolvedValue(null);
    expect(await cancelMyOrder("o1")).toEqual({ error: "Please sign in." });
  });

  it("★ refuses when the store hasn't switched self-cancellation on", async () => {
    // A rendered control is not a permission — the storefront hides the button,
    // but the action is a public endpoint and re-checks (invariant 5).
    (getStoreSettings as any).mockResolvedValue(
      settings({ "orders.allowCustomerCancellation": false }),
    );
    const res = await cancelMyOrder("o1");
    expect(res.error).toContain("contact them");
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("refuses when rate-limited", async () => {
    (rateLimit as any).mockResolvedValue({ allowed: false });
    const res = await cancelMyOrder("o1");
    expect(res.error).toContain("Too many attempts");
  });

  it("returns Not found for an order that isn't theirs", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await cancelMyOrder("o1")).toEqual({ error: "Not found." });
  });

  it("refuses an already-cancelled order", async () => {
    seedOrder({ status: "cancelled" });
    const res = await cancelMyOrder("o1");
    expect(res.error).toContain("already cancelled");
  });
});

describe("cancelMyOrder — still stoppable", () => {
  it("cancels, releases stock, and tells the store", async () => {
    const res = await cancelMyOrder("o1", "Ordered by mistake");

    expect(res.cancelled).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({ status: "cancelled" });
    expect(releaseCancelledOrder).toHaveBeenCalledWith(
      "store-1",
      "o1",
      expect.anything(),
      "customer_cancelled",
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.cancelled",
        payload: expect.objectContaining({ reason: "Ordered by mistake" }),
      }),
    );
  });

  it("★ NEVER moves money — it only reports what's owed", async () => {
    // A shopper must not be able to trigger a payout from a public storefront
    // action. The refund stays a human decision in the dashboard (§2.2).
    (refundDueForOrder as any).mockResolvedValue(840);
    const res = await cancelMyOrder("o1");

    expect(res.refundDue).toBe(840);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ refund_due: 840 }),
      }),
    );
  });

  it("omits refund_due entirely when nothing is owed", async () => {
    (refundDueForOrder as any).mockResolvedValue(0);
    await cancelMyOrder("o1");
    const payload = (emitEvent as any).mock.calls[0][0].payload;
    expect(payload).not.toHaveProperty("refund_due");
  });

  it("★ loses the race gracefully when the order ships mid-flight", async () => {
    // The claim's WHERE re-checks the status inside the statement that changes
    // it, so a dispatch racing this cancel means one matches nothing rather
    // than both "succeeding".
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            order_ref: "ORD1",
            status: "pending",
            payment_status: "paid",
            total: 840,
            created_at: new Date().toISOString(),
            collected_at: null,
          },
        ],
      ],
      returning: [], // the conditional UPDATE matched nothing
    });
    const res = await cancelMyOrder("o1");
    expect(res.error).toContain("moved on");
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("cancelMyOrder — too late, so it becomes a request", () => {
  it("★ a shipped order is requested, not cancelled", async () => {
    seedOrder({ status: "shipped" });
    const res = await cancelMyOrder("o1");

    expect(res.requested).toBe(true);
    expect(res.cancelled).toBeUndefined();
    // Nothing was touched — no claim, no stock release.
    expect(dbHolder.current.calls.set).toHaveLength(0);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.cancellation_requested" }),
    );
  });

  it("★ an order past the window is requested, even if still pending", async () => {
    seedOrder({}, 48); // placed 48h ago, window is 24h
    const res = await cancelMyOrder("o1");
    expect(res.requested).toBe(true);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  it("respects a longer window the merchant configured", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "orders.cancellationWindowHours": 72 }),
    );
    seedOrder({}, 48);
    const res = await cancelMyOrder("o1");
    expect(res.cancelled).toBe(true);
  });

  it("★ a collected pickup is requested — they already have the goods", async () => {
    seedOrder({ collected_at: new Date().toISOString() });
    const res = await cancelMyOrder("o1");
    expect(res.requested).toBe(true);
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
  });

  it("a POS sale (status 'completed') is requested, never auto-cancelled", async () => {
    seedOrder({ status: "completed" });
    expect((await cancelMyOrder("o1")).requested).toBe(true);
  });
});
