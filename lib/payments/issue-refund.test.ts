/* eslint-disable @typescript-eslint/no-explicit-any */
// The refund MECHANISM — shared by the dashboard and the till.
//
// ── Why this file is exhaustive ────────────────────────────────────────────
// This is the only call in the codebase where a RETRY IS DANGEROUS: a timeout
// is indistinguishable from a success nobody read, so getting one branch wrong
// pays a customer twice. The order of operations IS the design — write the row
// first with a key we generated, call the gateway with it, then claim the
// transition conditionally — and each step has a failure mode that must not be
// mistaken for another:
//
//   • a 4xx is a VERDICT      → fail the row, free the amount
//   • a 5xx or a throw is NOT → leave it pending, say so, do not retry
//   • losing the claim        → report pending, never assert what we didn't write
//
// It had no test file of its own; refund-actions.test.ts exercised it sideways
// while gating on the dashboard's authorization, which is a different concern.
// ★ Authorization is deliberately absent here — it is the CALLER's job — so
// nothing below asserts anything about who may refund.
//
// ⚠ WHAT THIS CANNOT COVER. The DB is a mock: `SELECT … FOR UPDATE` is
// asserted as "the lock was requested", never as serialising. That it actually
// serialises was proven separately against staging.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/payments/provider", () => ({ getStoreGateway: vi.fn() }));
vi.mock("@/lib/payments/razorpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments/razorpay")>()),
  rzpRefund: vi.fn(),
  rzpFetchOrderPayments: vi.fn(),
}));
vi.mock("@/lib/payments/refund-reconcile", () => ({
  reconcileOrderRefunds: vi.fn(async () => 0),
  syncOrderRefundState: vi.fn(async () => {}),
}));
vi.mock("@/lib/credit/store-credit", () => ({
  issueCredit: vi.fn(async () => ({ ok: true })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  // async, so a throw inside the callback arrives as a rejection — what the
  // real withService does, and what the reserve step's try/catch expects.
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import { getStoreGateway } from "@/lib/payments/provider";
import { rzpRefund, rzpFetchOrderPayments } from "@/lib/payments/razorpay";
import {
  reconcileOrderRefunds,
  syncOrderRefundState,
} from "@/lib/payments/refund-reconcile";
import { issueCredit } from "@/lib/credit/store-credit";
import { logError } from "@/lib/observability/logger";
import { issueRefund } from "./issue-refund";

const STORE = "store-1";
const ORDER = "o1";
const GATEWAY = { creds: { keyId: "rzp_test_x", keySecret: "s" } };

/** A paid online order of ₹500 with a captured payment. */
function order(over: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    order_ref: "ORD10011027",
    customer_id: "cust-1",
    total: 500,
    store_credit_used: 0,
    payment_method: "razorpay",
    payment_status: "paid",
    razorpay_payment_id: "pay_1",
    razorpay_order_id: "order_1",
    ...over,
  };
}

/**
 * @param orderRow   what the FOR UPDATE select finds ([] = no such order)
 * @param existing   refunds already on the order, for the cap
 * @param inserted   what the insert RETURNING gives back, and what the
 *                   settle-claim UPDATE returns ([] = the claim was lost)
 */
function seed(
  orderRow: any[] = [order()],
  existing: any[] = [],
  inserted: any[] = [{ id: "rf-new" }],
) {
  dbHolder.current = makeDbMock({
    selectQueue: [orderRow, existing],
    returning: inserted,
  });
}

const input = (over: Record<string, unknown> = {}) =>
  ({
    storeId: STORE,
    orderId: ORDER,
    method: "razorpay",
    actor: "owner@shop.test",
    ...over,
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStoreGateway).mockResolvedValue(GATEWAY as any);
  vi.mocked(rzpRefund).mockResolvedValue({
    ok: true,
    data: {
      id: "rfnd_1",
      payment_id: "pay_1",
      amount: 50000,
      status: "processed",
    },
  } as any);
  vi.mocked(issueCredit).mockResolvedValue({ ok: true } as any);
  seed();
});

/** The values written by the insert (the pending refund row). */
const written = () => dbHolder.current.calls.values[0];
/** The values written by each subsequent UPDATE … SET. */
const updates = () => dbHolder.current.calls.set;

// ---------------------------------------------------------------------------
// The reserve step — the row and the lock
// ---------------------------------------------------------------------------

describe("★ reserving the amount", () => {
  it("locks the order row before reading what is refundable", async () => {
    // Two people refunding at once would otherwise both read the same
    // headroom and both pass the cap — every individual check succeeding.
    await issueRefund(input());
    expect(dbHolder.current.calls.forUpdate).toContain("update");
  });

  it("★ writes the pending row BEFORE calling the gateway", async () => {
    // The whole design. Without a persisted key there is nothing to look the
    // refund up BY afterwards, and reconciliation degenerates into matching
    // on amount — which can't tell two ₹500 refunds apart.
    const order: string[] = [];
    dbHolder.current.db.insert = new Proxy(dbHolder.current.db.insert, {
      apply(t, s, a) {
        order.push("insert");
        return Reflect.apply(t, s, a);
      },
    });
    vi.mocked(rzpRefund).mockImplementation(async () => {
      order.push("gateway");
      return {
        ok: true,
        data: { id: "r", payment_id: "p", amount: 1, status: "processed" },
      } as any;
    });
    await issueRefund(input());
    expect(order).toEqual(["insert", "gateway"]);
  });

  it("★ sends the SAME key it persisted", async () => {
    // The invariant isn't what the uuid is, it's that one value is written to
    // the row and then handed to the gateway — that identity is the only
    // reason reconcile can find the refund afterwards. Asserted as a
    // relationship rather than against a fixed fixture, so it can't pass by
    // both sides being stubbed to the same constant.
    await issueRefund(input());
    const stored = written().idempotencyKey;
    expect(stored).toEqual(expect.any(String));
    expect(stored).toHaveLength(36);
    expect(vi.mocked(rzpRefund).mock.calls[0]![1]).toMatchObject({
      idempotencyKey: stored,
      paymentId: "pay_1",
      amountPaise: 50000,
    });
  });

  it("mints a fresh key for every refund", async () => {
    await issueRefund(input({ amount: 10 }));
    const first = written().idempotencyKey;
    seed();
    await issueRefund(input({ amount: 10 }));
    expect(written().idempotencyKey).not.toBe(first);
  });

  it("reconciles anything already in flight before deciding what's left", async () => {
    // A refund that timed out earlier is invisible to the cap until it
    // settles, and its amount would be handed back a second time.
    await issueRefund(input());
    expect(reconcileOrderRefunds).toHaveBeenCalledWith(ORDER);
  });

  it("refunds everything left when no amount is given", async () => {
    seed([order()], [{ amount: 200, status: "completed", method: "manual" }]);
    const res = await issueRefund(input());
    expect(res.amount).toBe(300);
  });

  it("refunds exactly what was asked for", async () => {
    const res = await issueRefund(input({ amount: 120 }));
    expect(res.amount).toBe(120);
    expect(written().amount).toBe(120);
  });

  it("refuses an order that isn't this store's", async () => {
    seed([]);
    expect(await issueRefund(input())).toEqual({ error: "Order not found." });
  });

  it("★ refuses more than remains", async () => {
    seed([order()], [{ amount: 400, status: "completed", method: "manual" }]);
    const res = await issueRefund(input({ amount: 200 }));
    expect(res.error).toContain("at most ₹100.00");
  });

  it("refuses when the order is already fully refunded", async () => {
    seed([order()], [{ amount: 500, status: "completed", method: "manual" }]);
    expect((await issueRefund(input())).error).toContain(
      "already been fully refunded",
    );
  });

  it("★ won't send money through a gateway that never took it", async () => {
    seed([order({ payment_method: "cash_on_delivery" })]);
    expect((await issueRefund(input())).error).toContain("wasn't paid online");
  });

  it("★ won't refund an online order that was never paid", async () => {
    seed([order({ payment_status: "pending" })]);
    expect((await issueRefund(input())).error).toContain("never paid");
  });

  it("lets a MANUAL refund proceed on an unpaid order", async () => {
    // Those two guards are gateway-specific: a merchant recording money they
    // moved themselves is not constrained by what Razorpay holds.
    seed([
      order({ payment_method: "cash_on_delivery", payment_status: "pending" }),
    ]);
    const res = await issueRefund(
      input({ method: "manual", reference: "UPI-1" }),
    );
    expect(res.status).toBe("completed");
  });

  it("applies the caller's extra check once the amount is REAL", async () => {
    // An omitted amount means "everything left", so a cap checked only against
    // the input is bypassed by leaving the field blank.
    const checkAmount = vi.fn(
      () => "Refunds over ₹100.00 need the store owner.",
    );
    const res = await issueRefund(input({ checkAmount }));
    expect(checkAmount).toHaveBeenCalledWith(500);
    expect(res.error).toContain("need the store owner");
  });

  it("proceeds when the caller's check passes", async () => {
    const res = await issueRefund(input({ checkAmount: () => null }));
    expect(res.status).toBe("completed");
  });

  it("trims and caps the free text it stores", async () => {
    await issueRefund(
      input({
        method: "manual",
        reason: "  " + "x".repeat(300),
        reference: "  " + "y".repeat(200),
      }),
    );
    expect(written().reason).toHaveLength(200);
    expect(written().reference).toHaveLength(120);
  });

  it("stores null for blank free text", async () => {
    await issueRefund(input({ reason: "   ", reference: "" }));
    expect(written().reason).toBeNull();
    expect(written().reference).toBeNull();
  });

  it("★ returns an error rather than throwing when the reserve fails", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("connection reset");
        },
      },
      calls: { values: [], set: [] },
    };
    expect(await issueRefund(input())).toEqual({
      error: "Couldn't start the refund.",
    });
    expect(logError).toHaveBeenCalledWith("refund.reserve", expect.any(Error), {
      orderId: ORDER,
    });
  });
});

// ---------------------------------------------------------------------------
// The money cap, including the store-credit half
// ---------------------------------------------------------------------------

describe("★ a money refund can't exceed what money paid", () => {
  it("caps cash at the total less the credit that settled it", async () => {
    // ₹500 of goods, ₹200 of it credit ⇒ only ₹300 ever arrived.
    seed([
      order({ store_credit_used: 200, payment_method: "cash_on_delivery" }),
    ]);
    const res = await issueRefund(input({ method: "manual", reference: "r" }));
    expect(res.amount).toBe(300);
  });

  it("does NOT cap a refund made as store credit", async () => {
    seed([order({ store_credit_used: 200 })]);
    const res = await issueRefund(input({ method: "store_credit" }));
    expect(res.amount).toBe(500);
  });

  it("counts prior MONEY refunds against the money cap", async () => {
    seed(
      [order({ store_credit_used: 200, payment_method: "cash_on_delivery" })],
      [{ amount: 100, status: "completed", method: "manual" }],
    );
    const res = await issueRefund(input({ method: "manual", reference: "r" }));
    expect(res.amount).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Non-gateway methods — the money already moved
// ---------------------------------------------------------------------------

describe("methods that only RECORD money", () => {
  it.each(["manual", "cash", "card", "upi"] as const)(
    "%s settles immediately and never calls Razorpay",
    async (method) => {
      seed([order({ payment_method: "cash_on_delivery" })]);
      const res = await issueRefund(input({ method, reference: "ref" }));
      expect(res.status).toBe("completed");
      expect(written().status).toBe("completed");
      expect(rzpRefund).not.toHaveBeenCalled();
      expect(syncOrderRefundState).toHaveBeenCalledWith(ORDER);
    },
  );

  it("★ a gateway refund carries NO location or shift", async () => {
    // It never touches a drawer, so stamping a shift would make the cash
    // report count money that never left the till.
    await issueRefund(input({ locationId: "loc-1", shiftId: "sh-1" }));
    expect(written()).toMatchObject({ locationId: null, shiftId: null });
  });

  it("a counter refund keeps both — the shift report needs them", async () => {
    seed([order({ payment_method: "cash" })]);
    await issueRefund(
      input({ method: "cash", locationId: "loc-1", shiftId: "sh-1" }),
    );
    expect(written()).toMatchObject({ locationId: "loc-1", shiftId: "sh-1" });
  });

  it("links the refund to the goods when there are goods", async () => {
    seed([order({ payment_method: "cash" })]);
    await issueRefund(input({ method: "cash", returnId: "ret-1" }));
    expect(written().returnId).toBe("ret-1");
  });

  it("stores a null return id when there aren't", async () => {
    await issueRefund(input());
    expect(written().returnId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Store credit
// ---------------------------------------------------------------------------

describe("refunding as store credit", () => {
  it("credits the order's customer and settles", async () => {
    seed([order({ payment_method: "cash_on_delivery" })]);
    const res = await issueRefund(input({ method: "store_credit" }));
    expect(res.status).toBe("completed");
    expect(issueCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: STORE,
        customerId: "cust-1",
        amount: 500,
        kind: "refund",
        // ★ Keyed on the refund ROW, which is why a retry is a no-op rather
        // than a second credit.
        ref: "rf-new",
      }),
    );
  });

  it("prefers an explicitly named customer", async () => {
    seed([order({ payment_method: "cash" })]);
    await issueRefund(
      input({ method: "store_credit", customerId: "other-cust" }),
    );
    expect(vi.mocked(issueCredit).mock.calls[0]![0].customerId).toBe(
      "other-cust",
    );
  });

  it("★ refuses a walk-in with no account, and fails the row", async () => {
    seed([order({ customer_id: null, payment_method: "cash" })]);
    const res = await issueRefund(input({ method: "store_credit" }));
    expect(res.code).toBe("no_customer");
    expect(res.error).toContain("nobody to give store credit to");
    // The reserved amount is freed, or it would block a real refund later.
    expect(updates()[0]).toMatchObject({ status: "failed" });
  });

  it("★ fails the row when the credit doesn't land", async () => {
    // Otherwise the refund reads as settled while the customer holds nothing.
    seed([order({ payment_method: "cash" })]);
    vi.mocked(issueCredit).mockResolvedValue({
      ok: false,
      error: "Couldn't add store credit.",
    } as any);
    const res = await issueRefund(input({ method: "store_credit" }));
    expect(res.error).toContain("Couldn't add store credit");
    expect(updates()[0]).toMatchObject({ status: "failed" });
  });
});

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

describe("the gateway path", () => {
  it("★ settles a processed refund and syncs the order", async () => {
    const res = await issueRefund(input());
    expect(res).toMatchObject({
      status: "completed",
      amount: 500,
      refundId: "rf-new",
    });
    expect(updates()[0]).toMatchObject({
      status: "completed",
      gatewayRefundId: "rfnd_1",
    });
    expect(syncOrderRefundState).toHaveBeenCalledWith(ORDER);
  });

  it("records a gateway-side failure without syncing", async () => {
    vi.mocked(rzpRefund).mockResolvedValue({
      ok: true,
      data: {
        id: "rfnd_1",
        payment_id: "pay_1",
        amount: 50000,
        status: "failed",
      },
    } as any);
    const res = await issueRefund(input());
    expect(res.status).toBe("failed");
    expect(syncOrderRefundState).not.toHaveBeenCalled();
  });

  it("leaves a created-but-unsettled refund pending", async () => {
    vi.mocked(rzpRefund).mockResolvedValue({
      ok: true,
      data: {
        id: "rfnd_1",
        payment_id: "pay_1",
        amount: 50000,
        status: "pending",
      },
    } as any);
    const res = await issueRefund(input());
    expect(res).toMatchObject({ status: "pending", pendingReconcile: true });
  });

  it("looks the payment up when the order has none recorded", async () => {
    seed([order({ razorpay_payment_id: null })]);
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [
        {
          id: "pay_found",
          order_id: "order_1",
          amount: 50000,
          status: "captured",
        },
      ],
    } as any);
    await issueRefund(input());
    expect(vi.mocked(rzpRefund).mock.calls[0]![1].paymentId).toBe("pay_found");
  });

  it("fails when the lookup finds nothing captured", async () => {
    seed([order({ razorpay_payment_id: null })]);
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [
        { id: "p", order_id: "order_1", amount: 50000, status: "authorized" },
      ],
    } as any);
    const res = await issueRefund(input());
    expect(res.code).toBe("no_captured_payment");
    expect(updates()[0]).toMatchObject({ status: "failed" });
  });

  it("fails when the lookup itself fails", async () => {
    seed([order({ razorpay_payment_id: null })]);
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "timeout",
    } as any);
    expect((await issueRefund(input())).code).toBe("no_captured_payment");
  });

  it("fails when there is no payment and no order to find one from", async () => {
    seed([order({ razorpay_payment_id: null, razorpay_order_id: null })]);
    expect((await issueRefund(input())).code).toBe("no_captured_payment");
    expect(rzpFetchOrderPayments).not.toHaveBeenCalled();
  });

  it("★ fails the row when the store's gateway is disconnected", async () => {
    vi.mocked(getStoreGateway).mockResolvedValue(null as any);
    const res = await issueRefund(input());
    expect(res.code).toBe("gateway_not_connected");
    expect(updates()[0]).toMatchObject({ status: "failed" });
    expect(rzpRefund).not.toHaveBeenCalled();
  });

  it("★ a REJECTION is a verdict — fail the row and free the amount", async () => {
    vi.mocked(rzpRefund).mockResolvedValue({
      ok: false,
      outcome: "rejected",
      error: "invalid request sent",
    } as any);
    const res = await issueRefund(input());
    expect(res.code).toBe("gateway_refused");
    expect(updates()[0]).toMatchObject({ status: "failed" });
  });

  it("★★ an UNKNOWN outcome is NOT a failure", async () => {
    // The single most important branch in this module. A 5xx or a network
    // throw means the refund MAY exist; reporting it as failed is precisely
    // how a customer gets paid twice. No error, no retry invitation, and the
    // row stays pending for reconcile to resolve from the key we planted.
    vi.mocked(rzpRefund).mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "socket hang up",
    } as any);
    const res = await issueRefund(input());
    expect(res).toMatchObject({
      status: "pending",
      pendingReconcile: true,
      refundId: "rf-new",
      amount: 500,
    });
    expect(res.error).toBeUndefined();
    expect(res.code).toBeUndefined();
    // Emphatically NOT marked failed.
    expect(updates()).toHaveLength(0);
    expect(logError).toHaveBeenCalledWith(
      "refund.gateway_unknown",
      "socket hang up",
      { orderId: ORDER, refundId: "rf-new" },
    );
  });

  it("★ reports pending when it loses the settle claim", async () => {
    // Something else settled the row first. We don't know what it wrote, and
    // "pending" is the honest answer — it sends the UI to "we're checking"
    // rather than asserting a state we didn't write.
    seed();
    // Only the UPDATE loses; the insert still has to succeed, so this can't be
    // expressed through the mock's single shared `returning`.
    dbHolder.current.db.update = vi.fn(() => ({
      set: (v: any) => {
        dbHolder.current.calls.set.push(v);
        return { where: () => ({ returning: async () => [] }) };
      },
    }));
    const res = await issueRefund(input());
    expect(res).toMatchObject({ status: "pending", pendingReconcile: true });
    expect(syncOrderRefundState).not.toHaveBeenCalled();
  });

  it("★ reports pending when the settle WRITE fails", async () => {
    // The money is moving; only our record of it failed. Reconcile fixes that
    // from the gateway, so it must not read as a failed refund.
    seed();
    const realUpdate = dbHolder.current.db.update;
    dbHolder.current.db.update = vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.reject(new Error("write failed")),
        }),
      }),
    }));
    const res = await issueRefund(input());
    expect(res.status).toBe("pending");
    expect(logError).toHaveBeenCalledWith(
      "refund.settle_write",
      expect.any(Error),
      {
        orderId: ORDER,
        refundId: "rf-new",
      },
    );
    dbHolder.current.db.update = realUpdate;
  });

  it("carries the order ref and store into the gateway's notes", async () => {
    await issueRefund(input());
    expect(vi.mocked(rzpRefund).mock.calls[0]![1].notes).toEqual({
      sm_order_ref: "ORD10011027",
      sm_store_id: STORE,
    });
  });

  it("returns the order ref and customer for the caller's event", async () => {
    const res = await issueRefund(input());
    expect(res).toMatchObject({
      orderRef: "ORD10011027",
      customerId: "cust-1",
    });
  });
});

// ---------------------------------------------------------------------------
// failRefund's own guard
// ---------------------------------------------------------------------------

describe("failing a row never throws", () => {
  it("swallows a write error while marking a refund failed", async () => {
    vi.mocked(getStoreGateway).mockResolvedValue(null as any);
    seed();
    dbHolder.current.db.update = vi.fn(() => ({
      set: () => ({ where: () => Promise.reject(new Error("write failed")) }),
    }));
    const res = await issueRefund(input());
    // The caller still gets its answer.
    expect(res.code).toBe("gateway_not_connected");
    expect(logError).toHaveBeenCalledWith(
      "refund.mark_failed",
      expect.any(Error),
      {
        refundId: "rf-new",
      },
    );
  });
});

// ---------------------------------------------------------------------------
// The defensive arms — malformed rows must not become wrong amounts
// ---------------------------------------------------------------------------

describe("★ null data degrades safely", () => {
  it("refuses to refund an order with no total", async () => {
    // A null total makes the cap zero, so nothing can leave. The alternative —
    // treating unknown as unlimited — is the one outcome that must not happen.
    seed([order({ total: null })]);
    expect((await issueRefund(input())).error).toContain(
      "already been fully refunded",
    );
  });

  it("counts an existing refund with no amount as zero, not NaN", async () => {
    // Without the `?? 0` the sum is NaN, every comparison against it is false,
    // and the cap silently stops bounding anything.
    seed([order()], [{ amount: null, status: "completed", method: "manual" }]);
    expect((await issueRefund(input())).amount).toBe(500);
  });

  it("falls back to the order id when a credit note has no ref to quote", async () => {
    seed([order({ order_ref: null, payment_method: "cash" })]);
    await issueRefund(input({ method: "store_credit" }));
    expect(vi.mocked(issueCredit).mock.calls[0]![0].note).toBe(
      `Refund on ${ORDER}`,
    );
  });

  it("sends an empty ref to the gateway rather than the string 'null'", async () => {
    // It rides into Razorpay's notes and is what a human reads when
    // reconciling by hand; "null" there is worse than blank.
    seed([order({ order_ref: null })]);
    await issueRefund(input());
    expect(vi.mocked(rzpRefund).mock.calls[0]![1].notes).toEqual({
      sm_order_ref: "",
      sm_store_id: STORE,
    });
  });

  it("still explains itself when the credit layer fails silently", async () => {
    // issueCredit is supposed to carry a message, but a refund that failed
    // with a blank reason is untraceable — the merchant is left with a dead
    // row and nothing to act on.
    seed([order({ payment_method: "cash" })]);
    vi.mocked(issueCredit).mockResolvedValue({ ok: false } as any);
    const res = await issueRefund(input({ method: "store_credit" }));
    expect(res.error).toBe("Couldn't add store credit.");
    expect(updates()[0]).toMatchObject({ status: "failed" });
  });
});
