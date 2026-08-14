/* eslint-disable @typescript-eslint/no-explicit-any */
// The merchant's own Razorpay webhook.
//
// Anyone can POST here, so almost every test below is about what happens when
// the caller is NOT Razorpay — and about the one scope check that stops a
// merchant holding a valid secret from reaching another merchant's orders.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/payments/store-webhook", () => ({
  loadPaymentWebhookSecret: vi.fn(),
}));
vi.mock("@/lib/orders/mark-paid", () => ({ markOrderPaid: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { POST } from "./[storeId]/route";
import { loadPaymentWebhookSecret } from "@/lib/payments/store-webhook";
import { markOrderPaid } from "@/lib/orders/mark-paid";
import { makeDbMock } from "@/app/actions/_test-helpers";

const STORE = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const SECRET = "whsec_test_secret";

const captured = (orderId = "order_rzp_1", paymentId = "pay_1") => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
});

function post(
  body: unknown,
  opts: { sign?: string | false; store?: string } = {},
) {
  const raw = JSON.stringify(body);
  const signature =
    opts.sign === false
      ? "deadbeef"
      : (opts.sign ?? createHmac("sha256", SECRET).update(raw).digest("hex"));
  return POST(
    new Request("https://acme.storemink.com/api/webhooks/payments/x", {
      method: "POST",
      body: raw,
      headers: { "x-razorpay-signature": signature },
    }),
    { params: Promise.resolve({ storeId: opts.store ?? STORE }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS, so every default has to
  // be restored explicitly. The "503 when processing throws" case below sets a
  // mockRejectedValue that otherwise leaks into whichever test runs next —
  // invisible in declaration order, caught by `npm run test:shuffle`.
  vi.mocked(loadPaymentWebhookSecret).mockResolvedValue(SECRET);
  vi.mocked(markOrderPaid).mockResolvedValue(undefined);
  dbHolder.current = makeDbMock({ selectQueue: [[{ id: "order-1" }]] });
});

describe("authorisation", () => {
  it("★★ a bad signature marks NOTHING paid", async () => {
    const res = await post(captured(), { sign: false });
    expect(res.status).toBe(401);
    expect(markOrderPaid).not.toHaveBeenCalled();
  });

  it("★★ a signature made with a DIFFERENT secret is refused", async () => {
    const raw = JSON.stringify(captured());
    const res = await post(captured(), {
      sign: createHmac("sha256", "someone-elses-secret")
        .update(raw)
        .digest("hex"),
    });
    expect(res.status).toBe(401);
    expect(markOrderPaid).not.toHaveBeenCalled();
  });

  it("★ a valid signature over DIFFERENT bytes is refused", async () => {
    // Signing one payload and sending another is the replay this guards.
    const res = await post(captured("order_rzp_1"), {
      sign: createHmac("sha256", SECRET)
        .update(JSON.stringify(captured("order_rzp_999")))
        .digest("hex"),
    });
    expect(res.status).toBe(401);
  });

  it("★★ 503, not 401, when we cannot LOAD a secret — so Razorpay retries", async () => {
    // No webhook configured, gateway paused, or the read failed. Reporting
    // "bad signature" would make Razorpay give up on a delivery we never
    // actually checked.
    vi.mocked(loadPaymentWebhookSecret).mockResolvedValue(null);
    const res = await post(captured());
    expect(res.status).toBe(503);
    expect(markOrderPaid).not.toHaveBeenCalled();
  });

  it("rejects a store id that cannot be one, before any work", async () => {
    const res = await post(captured(), { store: "../../etc/passwd" });
    expect(res.status).toBe(400);
    expect(loadPaymentWebhookSecret).not.toHaveBeenCalled();
  });
});

describe("scope", () => {
  it("settles the order the lookup matched", async () => {
    // ⚠ TEST GAP: the db mock does not evaluate WHERE clauses, so the
    // `store_id = storeId` predicate cannot be pinned directly — removing it
    // fails no test here. What IS covered is its consequence, in the next case:
    // when the scoped lookup finds nothing, nothing is marked paid.
    await post(captured());
    expect(markOrderPaid).toHaveBeenCalledWith("order-1", "pay_1");
  });

  it("★ an order that does not belong here is acknowledged, not actioned", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const res = await post(captured(), { store: OTHER });
    expect(res.status).toBe(200);
    expect(markOrderPaid).not.toHaveBeenCalled();
  });
});

describe("what it does with a verified delivery", () => {
  it("marks the matched order paid through the shared choke point", async () => {
    const res = await post(captured("order_rzp_1", "pay_abc"));
    expect(res.status).toBe(200);
    expect(markOrderPaid).toHaveBeenCalledWith("order-1", "pay_abc");
  });

  it("also handles order.paid", async () => {
    await post({
      event: "order.paid",
      payload: {
        payment: { entity: { id: "pay_2", order_id: "order_rzp_1" } },
      },
    });
    expect(markOrderPaid).toHaveBeenCalledWith("order-1", "pay_2");
  });

  it("★ ignores events it does not act on, with a 200", async () => {
    // A non-200 here fills the merchant's Razorpay dashboard with red over
    // messages we never wanted in the first place.
    const res = await post({ event: "refund.created", payload: {} });
    expect(res.status).toBe(200);
    expect(markOrderPaid).not.toHaveBeenCalled();
  });

  it("★ an event with no payment id is acknowledged, not actioned", async () => {
    const res = await post({
      event: "order.paid",
      payload: { order: { entity: { id: "order_rzp_1" } } },
    });
    expect(res.status).toBe(200);
    expect(markOrderPaid).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const raw = "not json";
    const res = await POST(
      new Request("https://acme.storemink.com/x", {
        method: "POST",
        body: raw,
        headers: {
          "x-razorpay-signature": createHmac("sha256", SECRET)
            .update(raw)
            .digest("hex"),
        },
      }),
      { params: Promise.resolve({ storeId: STORE }) },
    );
    expect(res.status).toBe(400);
  });

  it("★★ 503 when processing throws — a verified payment must not be dropped", async () => {
    vi.mocked(markOrderPaid).mockRejectedValue(new Error("db down"));
    const res = await post(captured());
    expect(res.status).toBe(503);
  });

  it("★ a REPLAY is safe because the claim inside markOrderPaid is conditional", async () => {
    // Razorpay retries deliveries. Both calls reach the choke point; only the
    // first one's claim matches a row, so the shopper is thanked once.
    await post(captured());
    // The mock's select queue is consumed per call, so re-seed for the retry —
    // in production the row is simply still there.
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "order-1" }]] });
    await post(captured());
    expect(markOrderPaid).toHaveBeenCalledTimes(2);
    expect(vi.mocked(markOrderPaid).mock.calls[0]).toEqual(
      vi.mocked(markOrderPaid).mock.calls[1],
    );
  });
});
