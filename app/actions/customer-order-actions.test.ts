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
vi.mock("@/lib/orders/approve-cancellation", () => ({
  approveCancellation: vi.fn(async () => ({ success: true })),
}));
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
import { approveCancellation } from "@/lib/orders/approve-cancellation";
import { refundDueForOrder } from "@/lib/payments/refund-reconcile";
import { cancelMyOrder } from "./customer-order-actions";

const USER = { id: "cust-1", email: "ada@example.test" };
const HOUR = 3_600_000;

function settings(overrides: Record<string, boolean | number | string> = {}) {
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
          cancellation_status: null,
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

describe("cancelMyOrder — raises a request", () => {
  // ★ ASKING IS NOT CANCELLING. This is the whole shape of Step 2: money and
  // stock move on APPROVAL, not on a customer pressing a button. Before this,
  // an eligible order was cancelled outright on the spot.
  it("★ records a request and tells the store, without cancelling", async () => {
    seedOrder();
    const res = await cancelMyOrder("o1", "ordered the wrong size");
    expect(res).toEqual({ requested: true });

    // The order is NOT cancelled — only the request columns move.
    const set = dbHolder.current.calls.set[0];
    expect(set.cancellationStatus).toBe("requested");
    expect(set.cancellationReason).toBe("ordered the wrong size");
    expect(set.status).toBeUndefined();

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.cancellation_requested" }),
    );
  });

  it("★ moves no stock and no money", async () => {
    seedOrder();
    await cancelMyOrder("o1");
    expect(releaseCancelledOrder).not.toHaveBeenCalled();
    expect(approveCancellation).not.toHaveBeenCalled();
  });

  it("★ loses the race gracefully when the order ships mid-flight", async () => {
    // The read said pending; the conditional UPDATE matched nothing because
    // something moved it. One of them wins, never both.
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
            cancellation_status: null,
          },
        ],
      ],
      returning: [],
    });
    const res = await cancelMyOrder("o1");
    expect(res.error).toContain("moved on");
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("cancelMyOrder — the rules are re-checked server-side", () => {
  it("★ a shipped order is refused, and pointed at returns", async () => {
    seedOrder({ status: "shipped" });
    const res = await cancelMyOrder("o1");
    expect(res.error).toMatch(/return it instead/i);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("★ an order past the window is refused", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "orders.cancellationWindow": "24h" }),
    );
    seedOrder({}, 48);
    const res = await cancelMyOrder("o1");
    expect(res.error).toMatch(/within 24 hours/i);
  });

  // ★ FIRST-CLASS RULE, not a very long duration.
  it("★ 'until fulfilled' ignores how long ago it was placed", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "orders.cancellationWindow": "until_fulfilled" }),
    );
    seedOrder({}, 24 * 90);
    expect((await cancelMyOrder("o1")).requested).toBe(true);
  });

  it("★ a collected pickup is refused — they already have the goods", async () => {
    seedOrder({ collected_at: new Date().toISOString() });
    const res = await cancelMyOrder("o1");
    expect(res.error).toMatch(/fulfilled/i);
  });

  // ★ ONE ACTIVE REQUEST PER ORDER, and a decline must stick.
  it("★ refuses a second request, and refuses re-asking after a decline", async () => {
    seedOrder({ cancellation_status: "requested" });
    expect((await cancelMyOrder("o1")).error).toMatch(/already asked/i);

    seedOrder({ cancellation_status: "declined" });
    expect((await cancelMyOrder("o1")).error).toMatch(/declined/i);
  });
});

describe("cancelMyOrder — automatic approval", () => {
  // OFF by default: an automatic approval moves money with nobody looking.
  it("★ does not auto-approve unless the merchant switched it on", async () => {
    seedOrder();
    await cancelMyOrder("o1");
    expect(approveCancellation).not.toHaveBeenCalled();
  });

  it("cancels straight away when the merchant enabled it", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "orders.cancellationApproval": "auto" }),
    );
    (approveCancellation as any).mockResolvedValue({
      success: true,
      refundDue: 840,
    });
    seedOrder();
    expect(await cancelMyOrder("o1")).toEqual({
      cancelled: true,
      refundDue: 840,
    });
  });

  // ★ NEVER REPORT A CANCELLATION THAT DID NOT HAPPEN. The request stands and
  // is in the merchant's queue, which is the honest outcome.
  it("★ falls back to 'requested' when the approval fails", async () => {
    (getStoreSettings as any).mockResolvedValue(
      settings({ "orders.cancellationApproval": "auto" }),
    );
    (approveCancellation as any).mockResolvedValue({ error: "nope" });
    seedOrder();
    expect(await cancelMyOrder("o1")).toEqual({ requested: true });
  });
});
