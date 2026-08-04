/* eslint-disable @typescript-eslint/no-explicit-any */
// Settling refunds whose outcome we never learned.
//
// ── Why this file is exhaustive ────────────────────────────────────────────
// This module is the backstop for the one case in the codebase where guessing
// pays a customer twice: `refundOrder` writes its row BEFORE calling Razorpay,
// so a timeout leaves a `pending` row that only this code ever resolves. Every
// `return false` in `settle` is a deliberate decision to LEAVE MONEY UNCERTAIN
// rather than assert something we don't know — so each one needs a test saying
// "and it stays pending", not just a happy path proving the good case works.
//
// The matrix below is every branch: gateway missing, payment id absent, each
// fetch failing, no key, no match inside and outside the grace window, each
// gateway status, and both sides of every conditional claim.
//
// ⚠ WHAT THIS CANNOT COVER. The DB is a mock, so `loadPending`'s SQL
// predicates — pending + razorpay + older than the grace window — are asserted
// only as "the query was built and limited", never as filtering. The same
// caveat as every action test here: these prove the code's decisions, not that
// Postgres agrees.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/payments/provider", () => ({ getStoreGateway: vi.fn() }));
// Only the NETWORK calls are faked — `capturedPayment` stays real, so the
// "which payment counts" rule is exercised rather than restated.
vi.mock("@/lib/payments/razorpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments/razorpay")>()),
  rzpFetchOrderPayments: vi.fn(),
  rzpFetchPaymentRefunds: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getStoreGateway } from "@/lib/payments/provider";
import {
  rzpFetchOrderPayments,
  rzpFetchPaymentRefunds,
} from "@/lib/payments/razorpay";
import { logError } from "@/lib/observability/logger";
import {
  reconcileOrderRefunds,
  refundDueForOrder,
  sweepPendingRefunds,
  syncOrderRefundState,
} from "./refund-reconcile";

const GATEWAY = { creds: { keyId: "rzp_test_x", keySecret: "s" } };
const KEY = "idem-key-1";
const MINUTE = 60_000;

/** A pending row old enough to be chased, but inside the "don't fail it yet"
 *  window — the ordinary case for everything except the give-up tests. */
function pendingRow(over: Record<string, unknown> = {}) {
  return {
    id: "rf-1",
    store_id: "store-1",
    order_id: "o1",
    amount: 500,
    idempotency_key: KEY,
    created_at: new Date(Date.now() - 5 * MINUTE).toISOString(),
    razorpay_payment_id: "pay_1",
    razorpay_order_id: "order_1",
    ...over,
  };
}

/** A refund as Razorpay lists it, carrying our key in `notes`. */
function gatewayRefund(over: Record<string, unknown> = {}) {
  return {
    id: "rfnd_gw_1",
    payment_id: "pay_1",
    amount: 50000,
    status: "processed",
    notes: { sm_refund_key: KEY },
    ...over,
  };
}

/**
 * The literal text of a Drizzle `sql` fragment.
 *
 * Its chunks alternate strings and Column objects, and a Column points back at
 * its table — so JSON.stringify throws on the cycle. Only the string chunks
 * are interesting here: the column is the gap in `coalesce(, '…')`.
 */
function sqlText(fragment: unknown): string {
  const chunks = (fragment as any)?.queryChunks ?? [];
  return chunks
    .flatMap((c: any) =>
      Array.isArray(c?.value)
        ? c.value
        : typeof c?.value === "string"
          ? [c.value]
          : [],
    )
    .join("");
}

/**
 * @param selects  rows for each db.select(), in order:
 *                 [pending rows, (order), (settled refunds)]
 * @param claimed  what the conditional UPDATE ... RETURNING gives back.
 *                 [] models losing the claim to a concurrent reconcile.
 */
function seed(selects: any[][], claimed: any[] = [{ id: "rf-1" }]) {
  dbHolder.current = makeDbMock({ selectQueue: selects, returning: claimed });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStoreGateway).mockResolvedValue(GATEWAY as any);
  vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
    ok: true,
    data: [
      { id: "pay_1", order_id: "order_1", amount: 50000, status: "captured" },
    ],
  } as any);
  vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
    ok: true,
    data: [gatewayRefund()],
  } as any);
  seed([[pendingRow()], [{ total: 500, paid: "paid" }], [{ amount: 500 }]]);
});

// ---------------------------------------------------------------------------
// settle — the happy paths
// ---------------------------------------------------------------------------

describe("settle — the gateway answers", () => {
  it("★ marks a processed refund completed and syncs the order", async () => {
    expect(await reconcileOrderRefunds("o1")).toBe(1);
    const set = dbHolder.current.calls.set;
    expect(set[0]).toMatchObject({
      status: "completed",
      gatewayRefundId: "rfnd_gw_1",
    });
    // The order was fully refunded, so it follows.
    expect(set[1]).toMatchObject({ paymentStatus: "refunded" });
  });

  it("★ marks a failed refund failed — and does NOT sync the order", async () => {
    // Only a settlement changes what the order owes. Syncing on a failure
    // would be harmless here but wrong in principle: nothing moved.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [gatewayRefund({ status: "failed" })],
    } as any);
    seed([[pendingRow()]]);
    expect(await reconcileOrderRefunds("o1")).toBe(1);
    expect(dbHolder.current.calls.set).toHaveLength(1);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "failed" });
  });

  it("looks the payment up when the order never recorded one", async () => {
    seed([
      [pendingRow({ razorpay_payment_id: null })],
      [{ total: 500, paid: "paid" }],
      [{ amount: 500 }],
    ]);
    expect(await reconcileOrderRefunds("o1")).toBe(1);
    expect(rzpFetchOrderPayments).toHaveBeenCalledWith(
      GATEWAY.creds,
      "order_1",
    );
  });

  it("doesn't look it up when the order already has one", async () => {
    await reconcileOrderRefunds("o1");
    expect(rzpFetchOrderPayments).not.toHaveBeenCalled();
  });

  it("matches on OUR key, never on amount", async () => {
    // Two refunds of the same amount on one payment are indistinguishable by
    // value; settling the wrong row is unrecoverable.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [
        gatewayRefund({
          id: "rfnd_other",
          notes: { sm_refund_key: "someone-else" },
        }),
        gatewayRefund({ id: "rfnd_mine" }),
      ],
    } as any);
    seed([[pendingRow()], [{ total: 500, paid: "paid" }], [{ amount: 500 }]]);
    await reconcileOrderRefunds("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      gatewayRefundId: "rfnd_mine",
    });
  });
});

// ---------------------------------------------------------------------------
// settle — every reason to leave it pending
// ---------------------------------------------------------------------------

describe("★ settle — an unresolved row STAYS pending", () => {
  /** Nothing was written and nothing was counted. */
  function expectUntouched(settled: number) {
    expect(settled).toBe(0);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  }

  it("when the store's gateway is gone", async () => {
    // Disconnecting Razorpay must not retroactively fail refunds that may
    // already have paid the customer.
    vi.mocked(getStoreGateway).mockResolvedValue(null as any);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });

  it("when fetching the order's payments fails", async () => {
    seed([[pendingRow({ razorpay_payment_id: null })]]);
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "timeout",
    } as any);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });

  it("when the order has no CAPTURED payment", async () => {
    // An authorized-but-uncaptured payment took no money, so there is nothing
    // to send back — but we still don't know what happened to our refund call.
    seed([[pendingRow({ razorpay_payment_id: null })]]);
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [
        {
          id: "pay_x",
          order_id: "order_1",
          amount: 50000,
          status: "authorized",
        },
      ],
    } as any);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });

  it("when there is no payment id and no razorpay order to find one from", async () => {
    seed([
      [pendingRow({ razorpay_payment_id: null, razorpay_order_id: null })],
    ]);
    expectUntouched(await reconcileOrderRefunds("o1"));
    expect(rzpFetchOrderPayments).not.toHaveBeenCalled();
  });

  it("when listing the payment's refunds fails", async () => {
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: false,
      outcome: "unknown",
      error: "503",
    } as any);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });

  it("★ when the gateway still calls it pending", async () => {
    // In flight. Asking again tomorrow costs nothing; guessing does not.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [gatewayRefund({ status: "pending" })],
    } as any);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });

  it("★ when the gateway reports a status we've never seen", async () => {
    // An unknown state maps to pending, never to settled — a new Razorpay
    // status must not be able to close a refund by accident.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [gatewayRefund({ status: "some_new_state" })],
    } as any);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });

  it("★ when no refund carries our key and the row is still young", async () => {
    // Either the create never landed, or their list is lagging. Failing it now
    // would free the amount for a SECOND refund of money already on its way.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [],
    } as any);
    seed([
      [
        pendingRow({
          created_at: new Date(Date.now() - 10 * MINUTE).toISOString(),
        }),
      ],
    ]);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });

  it("★ when the row carries no key at all", async () => {
    // Nothing to match on, so it can never be resolved from the list. It waits
    // out the window and is then given up on, like any unmatched row — it must
    // NOT be settled against whatever refund happens to be there.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [gatewayRefund()],
    } as any);
    seed([
      [
        pendingRow({
          idempotency_key: null,
          created_at: new Date().toISOString(),
        }),
      ],
    ]);
    expectUntouched(await reconcileOrderRefunds("o1"));
  });
});

// ---------------------------------------------------------------------------
// settle — giving up, only after a long wait
// ---------------------------------------------------------------------------

describe("★ settle — giving up on a refund that never reached the gateway", () => {
  const OLD = () => new Date(Date.now() - 45 * MINUTE).toISOString();

  beforeEach(() => {
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [],
    } as any);
  });

  it("fails the row once it is far past the grace window", async () => {
    // 30 minutes — fifteen times the settle grace. By then "Razorpay has no
    // record of it" is the only reading left.
    seed([[pendingRow({ created_at: OLD() })]]);
    expect(await reconcileOrderRefunds("o1")).toBe(1);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ status: "failed" });
  });

  it("keeps an existing reason instead of overwriting it", async () => {
    // The stored reason is the merchant's own note; the fallback only fills a
    // blank. It is a Drizzle `sql` fragment rather than a string because
    // coalesce runs in the DB, so the assertion reads its chunks.
    seed([[pendingRow({ created_at: OLD() })]]);
    await reconcileOrderRefunds("o1");
    expect(sqlText(dbHolder.current.calls.set[0].reason)).toBe(
      "coalesce(, 'Never reached the gateway')",
    );
  });

  it("★ does NOT sync the order — a failed refund settles no money", async () => {
    seed([[pendingRow({ created_at: OLD() })]]);
    await reconcileOrderRefunds("o1");
    expect(dbHolder.current.calls.set).toHaveLength(1);
  });

  it("★ reports nothing when it loses the claim to a concurrent run", async () => {
    // reconcile-on-read and the cron can fire together. The conditional UPDATE
    // means one wins; the loser must not double-count it as settled.
    seed([[pendingRow({ created_at: OLD() })]], []);
    expect(await reconcileOrderRefunds("o1")).toBe(0);
  });

  it("waits at exactly the boundary rather than acting early", async () => {
    // 30 minutes exactly: `age < window` is false only once past it, so a row
    // on the line is left alone. Bias toward waiting is the whole design.
    seed([
      [
        pendingRow({
          created_at: new Date(Date.now() - 29 * MINUTE).toISOString(),
        }),
      ],
    ]);
    expect(await reconcileOrderRefunds("o1")).toBe(0);
  });
});

describe("★ a settled row that loses its claim isn't counted either", () => {
  it("returns 0 and never syncs the order", async () => {
    seed([[pendingRow()]], []);
    expect(await reconcileOrderRefunds("o1")).toBe(0);
    // One UPDATE attempted (it lost), and no follow-on order sync.
    expect(dbHolder.current.calls.set).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// syncOrderRefundState — derived, never accumulated
// ---------------------------------------------------------------------------

describe("syncOrderRefundState", () => {
  /** @param settled the `completed` refund rows on the order */
  function seedOrder(order: any, settled: any[]) {
    seed([[order], settled]);
  }

  it("marks an order fully refunded when the refunds cover it", async () => {
    seedOrder({ total: 500, paid: "paid" }, [{ amount: 500 }]);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "refunded",
    });
  });

  it("marks it partially refunded when they don't", async () => {
    seedOrder({ total: 500, paid: "paid" }, [{ amount: 200 }]);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "partially_refunded",
    });
  });

  it("sums several settled refunds", async () => {
    seedOrder({ total: 500, paid: "paid" }, [{ amount: 200 }, { amount: 300 }]);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "refunded",
    });
  });

  it("treats an over-refund as fully refunded, not something stranger", async () => {
    seedOrder({ total: 500, paid: "paid" }, [{ amount: 600 }]);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "refunded",
    });
  });

  it("★ moves an order BACK off refunded when its refund failed", async () => {
    // This is why the status is derived rather than accumulated: a counter
    // that only goes up can't undo a refund that turned out not to happen.
    seedOrder({ total: 500, paid: "refunded" }, []);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "paid",
    });
  });

  it("★ moves it back off partially_refunded too", async () => {
    seedOrder({ total: 500, paid: "partially_refunded" }, []);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "paid",
    });
  });

  it("★ does NOT resurrect an unpaid order", async () => {
    // `pending` with no settled refunds must stay pending — deriving "paid"
    // from an absence of refunds would mark an unpaid order paid.
    seedOrder({ total: 500, paid: "pending" }, []);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("writes nothing when the status is already right", async () => {
    seedOrder({ total: 500, paid: "refunded" }, [{ amount: 500 }]);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("writes nothing for an order that doesn't exist", async () => {
    seed([[], []]);
    await syncOrderRefundState("nope");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("leaves a null payment status alone", async () => {
    seedOrder({ total: 500, paid: null }, []);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("treats a zero-total order as fully refunded once anything settles", async () => {
    seedOrder({ total: 0, paid: "paid" }, [{ amount: 5 }]);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "refunded",
    });
  });

  it("★ swallows a DB failure — it is never the reason a page breaks", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("connection reset");
        },
      },
      calls: { set: [] },
    };
    await expect(syncOrderRefundState("o1")).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "refund.sync_order_state",
      expect.any(Error),
      { orderId: "o1" },
    );
  });
});

// ---------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------

describe("reconcileOrderRefunds — the read path", () => {
  it("returns 0 when the order has nothing pending", async () => {
    seed([[]]);
    expect(await reconcileOrderRefunds("o1")).toBe(0);
    expect(getStoreGateway).not.toHaveBeenCalled();
  });

  it("counts only the rows that actually moved", async () => {
    // Two rows: the first settles, the second is still in flight at Razorpay.
    vi.mocked(rzpFetchPaymentRefunds)
      .mockResolvedValueOnce({ ok: true, data: [gatewayRefund()] } as any)
      .mockResolvedValueOnce({
        ok: true,
        data: [gatewayRefund({ status: "pending" })],
      } as any);
    seed([
      [pendingRow(), pendingRow({ id: "rf-2" })],
      [{ total: 500, paid: "paid" }],
      [{ amount: 500 }],
    ]);
    expect(await reconcileOrderRefunds("o1")).toBe(1);
  });

  it("caps how much one page load will chase", async () => {
    await reconcileOrderRefunds("o1");
    expect(dbHolder.current.calls.limit).toContain(20);
  });

  it("★ returns 0 rather than throwing when the query fails", async () => {
    // The caller is rendering an order page. A slow gateway or a bad query
    // must not take the page down with it.
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("boom");
        },
      },
      calls: { set: [] },
    };
    await expect(reconcileOrderRefunds("o1")).resolves.toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "refund.reconcile_order",
      expect.any(Error),
      {
        orderId: "o1",
      },
    );
  });

  it("★ returns 0 when the GATEWAY call throws outright", async () => {
    // A rejected promise, not an { ok: false } — settle has no try of its own,
    // so the entry point's catch is the only thing standing there.
    vi.mocked(getStoreGateway).mockRejectedValue(
      new Error("creds decrypt failed"),
    );
    await expect(reconcileOrderRefunds("o1")).resolves.toBe(0);
    expect(logError).toHaveBeenCalled();
  });
});

describe("sweepPendingRefunds — the cron backstop", () => {
  it("settles across stores and reports the count", async () => {
    seed([
      [pendingRow(), pendingRow({ id: "rf-2", store_id: "store-2" })],
      [{ total: 500, paid: "paid" }],
      [{ amount: 500 }],
      [{ total: 500, paid: "paid" }],
      [{ amount: 500 }],
    ]);
    expect(await sweepPendingRefunds()).toBe(2);
    expect(getStoreGateway).toHaveBeenCalledWith("store-1");
    expect(getStoreGateway).toHaveBeenCalledWith("store-2");
  });

  it("defaults to 100 rows a run", async () => {
    await sweepPendingRefunds();
    expect(dbHolder.current.calls.limit).toContain(100);
  });

  it("honours an explicit limit", async () => {
    await sweepPendingRefunds(5);
    expect(dbHolder.current.calls.limit).toContain(5);
  });

  it("returns 0 when there is nothing pending anywhere", async () => {
    seed([[]]);
    expect(await sweepPendingRefunds()).toBe(0);
  });

  it("★ returns 0 rather than throwing — it shares a cron with pickups", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("boom");
        },
      },
      calls: { set: [] },
    };
    await expect(sweepPendingRefunds()).resolves.toBe(0);
    expect(logError).toHaveBeenCalledWith("refund.sweep", expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// refundDueForOrder — the obligation a cancellation must surface
// ---------------------------------------------------------------------------

describe("refundDueForOrder", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: "o1",
    total: 500,
    paymentStatus: "paid",
    ...over,
  });

  it("owes the whole total when nothing has gone back", async () => {
    seed([[]]);
    expect(await refundDueForOrder(order())).toBe(500);
  });

  it("owes the remainder after a partial refund", async () => {
    seed([[{ amount: 200, status: "completed" }]]);
    expect(await refundDueForOrder(order())).toBe(300);
  });

  it("owes nothing once fully refunded", async () => {
    seed([[{ amount: 500, status: "completed" }]]);
    expect(await refundDueForOrder(order())).toBe(0);
  });

  it("★ counts a PENDING refund against what is owed", async () => {
    // It hasn't settled but it might. Ignoring it would prompt a merchant to
    // send the same money a second time.
    seed([[{ amount: 500, status: "pending" }]]);
    expect(await refundDueForOrder(order())).toBe(0);
  });

  it("★ a FAILED refund frees its amount again", async () => {
    seed([[{ amount: 500, status: "failed" }]]);
    expect(await refundDueForOrder(order())).toBe(500);
  });

  it("still owes the balance on a partially_refunded order", async () => {
    seed([[{ amount: 200, status: "completed" }]]);
    expect(
      await refundDueForOrder(order({ paymentStatus: "partially_refunded" })),
    ).toBe(300);
  });

  it.each(["pending", "failed", "refunded", null, undefined, ""])(
    "★ owes nothing on a %s order, without even asking the DB",
    async (status) => {
      // Never captured, or already settled. Inventing an obligation is worse
      // than missing one, and the early return keeps a cron cheap.
      seed([[{ amount: 999, status: "completed" }]]);
      expect(
        await refundDueForOrder(order({ paymentStatus: status as any })),
      ).toBe(0);
      expect(dbHolder.current.calls.select).toHaveLength(0);
    },
  );

  it("treats a null total as owing nothing", async () => {
    seed([[]]);
    expect(await refundDueForOrder(order({ total: null }))).toBe(0);
  });

  it("★ returns 0 rather than throwing when the query fails", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("boom");
        },
      },
      calls: { select: [] },
    };
    expect(await refundDueForOrder(order())).toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "refund.due_for_order",
      expect.any(Error),
      {
        orderId: "o1",
      },
    );
  });
});

// ---------------------------------------------------------------------------
// The defensive arms — each one is a "shouldn't happen" that must still be safe
// ---------------------------------------------------------------------------

describe("★ malformed rows fail safe rather than fail open", () => {
  it("never gives up on a pending row with no timestamp", async () => {
    // An undated row reads as brand new, so the give-up window never elapses
    // and it stays pending forever — which is the right way round. The other
    // reading would treat a NULL created_at as infinitely old and fail a
    // refund that may already have paid the customer.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [],
    } as any);
    seed([[pendingRow({ created_at: null })]]);
    expect(await reconcileOrderRefunds("o1")).toBe(0);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("treats an order with no total as fully refunded once anything settles", async () => {
    // A null total makes the threshold zero, so any settled amount clears it.
    // "Partially refunded against an unknown total" would be a worse answer:
    // it implies a balance nobody can compute.
    seed([[{ total: null, paid: "paid" }], [{ amount: 100 }]]);
    await syncOrderRefundState("o1");
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      paymentStatus: "refunded",
    });
  });

  it("counts a refund row with no amount as zero, not NaN", async () => {
    // Without the `?? 0` this returns NaN, and every comparison against NaN is
    // false — so the cap would silently stop bounding anything.
    seed([[{ amount: null, status: "completed" }]]);
    expect(
      await refundDueForOrder({ id: "o1", total: 500, paymentStatus: "paid" }),
    ).toBe(500);
  });

  it("the sweep counts only the rows that moved", async () => {
    // A run that resolves nothing reports 0 rather than the number it looked
    // at — the cron's log line is how anyone notices refunds are stuck.
    vi.mocked(rzpFetchPaymentRefunds).mockResolvedValue({
      ok: true,
      data: [gatewayRefund({ status: "pending" })],
    } as any);
    seed([[pendingRow(), pendingRow({ id: "rf-2" })]]);
    expect(await sweepPendingRefunds()).toBe(0);
  });
});
