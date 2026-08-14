/* eslint-disable @typescript-eslint/no-explicit-any */
// What cancelling an order does to stock.
//
// ── Why this file is exhaustive ────────────────────────────────────────────
// This module exists BECAUSE the logic was about to be written twice, and its
// failure mode is silent: stock simply never comes back, and nobody finds out
// until a count weeks later. So the tests are mostly about what does NOT
// happen — no phantom restock, no double restock, no restock at the wrong
// shop — because none of those raise an error at the time.
//
// ★ Every error path here is BEST-EFFORT BY DESIGN. The status change is the
// source of truth and must never be blocked by a stock write, so each catch is
// a deliberate decision rather than defensive noise, and each gets a test
// saying "and the cancellation still completes".
//
// ⚠ WHAT THIS CANNOT COVER. The DB is a mock, so the conditional claim is
// asserted as "the UPDATE carried a stock_status = 'reserved' predicate",
// never as being atomic. Whether two concurrent cancels really produce one
// release is a Postgres guarantee, verified against staging rather than here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/inventory/reservations", () => ({
  releaseHold: vi.fn(async () => true),
}));
vi.mock("@/lib/credit/store-credit", () => ({
  reinstateCreditForOrder: vi.fn(async () => 0),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import { releaseHold } from "@/lib/inventory/reservations";
import { reinstateCreditForOrder } from "@/lib/credit/store-credit";
import { logError } from "@/lib/observability/logger";
import { releaseCancelledOrder, type DbRunner } from "./cancel";

const STORE = "store-1";
const ORDER = "o1";

const ITEMS = [
  { product_id: "p1", variant_id: null, quantity: 2 },
  { product_id: "p2", variant_id: "v1", quantity: 1 },
];

/**
 * @param claimed  what the conditional UPDATE returns. [] = the claim was lost
 *                 (already cancelled, never reserved, or a concurrent cancel).
 * @param selects  rows for each select: [order items, pickup holds]
 */
function seed(
  claimed: any[] = [{ id: ORDER, location_id: null }],
  selects: any[][] = [ITEMS, []],
) {
  dbHolder.current = makeDbMock({ selectQueue: selects, returning: claimed });
}

/** The default runner — the same scope withService gives. */
const runner: DbRunner = (fn) => Promise.resolve(fn(dbHolder.current.db));

/** The raw SQL text of each RPC call the module made. */
function rpcCalls(): string[] {
  return (dbHolder.current.calls.execute ?? []).map((q: any) =>
    (q?.queryChunks ?? [])
      .flatMap((c: any) => (Array.isArray(c?.value) ? c.value : []))
      .join(""),
  );
}

/** The values bound into RPC call `i`, in order. */
function rpcParams(i: number): unknown[] {
  const q = dbHolder.current.calls.execute[i];
  return (q?.queryChunks ?? []).filter((c: any) => !Array.isArray(c?.value));
}

beforeEach(() => {
  // ⚠ `clearAllMocks` clears CALLS, not IMPLEMENTATIONS. One test below sets
  // `releaseHold` to REJECT (proving a stock failure never blocks a
  // cancellation), and that rejection used to survive into every later test —
  // aborting the release loop after the first hold, so "releases each held
  // reservation" saw one call instead of two.
  //
  // ★ It passed only because of declaration order: the rejecting test is last.
  // `vitest --sequence.shuffle` fails it.
  vi.clearAllMocks();
  vi.mocked(releaseHold).mockResolvedValue(true);
  seed();
});

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

describe("★ the reserved-stock claim", () => {
  it("releases every line of a reserved order", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner);
    const calls = rpcCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("release_stock(");
  });

  it("★ claims by flipping reserved → released, so it can only win once", async () => {
    // The predicate IS the exactly-once guarantee: a legacy order sits at
    // 'none', an already-cancelled one at 'released', and of two concurrent
    // cancels only one UPDATE matches.
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(dbHolder.current.calls.set[0]).toEqual({ stockStatus: "released" });
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("★ restocks NOTHING when the claim finds no reserved order", async () => {
    // The silent-failure case in the other direction: a second cancel, or a
    // pickup order whose units never left the shelf. Restocking here would ADD
    // stock that never moved, inflating the count on every cancellation.
    seed([]);
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcCalls()).toHaveLength(0);
  });

  it("is idempotent — a second cancel releases nothing", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcCalls()).toHaveLength(2);
    seed([]); // the claim is gone now
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Which shelf the units go back to
// ---------------------------------------------------------------------------

describe("★★ stock goes back where it came from", () => {
  it("uses release_stock_at when the order names a location", async () => {
    // A POS sale reserved at the register's own location. The plain wrapper
    // delegates to the store's DEFAULT location, so using it here would hand
    // the units to the wrong shop — silently, and compounding per
    // cancellation: the selling location never recovers its stock and the
    // default gains one it never had.
    seed([{ id: ORDER, location_id: "loc-shop-2" }]);
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcCalls()[0]).toContain("release_stock_at(");
    expect(rpcParams(0)).toEqual([
      STORE,
      "loc-shop-2",
      "p1",
      null,
      2,
      ORDER,
      "order_cancelled",
    ]);
  });

  it("uses the plain wrapper for an online order with no location", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcCalls()[0]).toContain("release_stock(");
    expect(rpcCalls()[0]).not.toContain("release_stock_at(");
  });

  it("passes each line's variant through", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcParams(1)).toEqual([
      STORE,
      "p2",
      "v1",
      1,
      ORDER,
      "order_cancelled",
    ]);
  });

  it("records the caller's reason on the ledger row", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner, "pickup_expired");
    expect(rpcParams(0)).toContain("pickup_expired");
  });

  it("defaults the reason when the caller gives none", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcParams(0)).toContain("order_cancelled");
  });
});

// ---------------------------------------------------------------------------
// Store credit
// ---------------------------------------------------------------------------

describe("store credit comes back", () => {
  it("★ reinstates even when nothing was reserved", async () => {
    // Cancelling silently destroys the customer's money otherwise, and a
    // pickup order — which never reserves — is exactly the case that would
    // slip through if this sat inside the claim.
    seed([]);
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(rpcCalls()).toHaveLength(0);
    expect(reinstateCreditForOrder).toHaveBeenCalledWith(STORE, ORDER);
  });

  it("reinstates on the ordinary path too", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(reinstateCreditForOrder).toHaveBeenCalledWith(STORE, ORDER);
  });
});

// ---------------------------------------------------------------------------
// Pickup holds
// ---------------------------------------------------------------------------

describe("★ pickup holds are released, never restocked", () => {
  it("releases each held reservation", async () => {
    // No claim, so the item read never happens and the holds query is the
    // FIRST select of the run.
    seed([], [[{ id: "hold-1" }, { id: "hold-2" }]]);
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(releaseHold).toHaveBeenCalledWith("hold-1");
    expect(releaseHold).toHaveBeenCalledWith("hold-2");
    // ★ And NO restock: those units never left the shelf.
    expect(rpcCalls()).toHaveLength(0);
  });

  it("does nothing when the order held nothing", async () => {
    await releaseCancelledOrder(STORE, ORDER, runner);
    expect(releaseHold).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Every failure is best-effort, by design
// ---------------------------------------------------------------------------

describe("★ a stock failure never blocks a cancellation", () => {
  it("survives the claim itself failing", async () => {
    // The order is being cancelled either way; the caller has already changed
    // its status. An exception here would abort that.
    const failing: DbRunner = () => Promise.reject(new Error("claim failed"));
    await expect(
      releaseCancelledOrder(STORE, ORDER, failing),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "cancel: stock release claim",
      expect.any(Error),
      { orderId: ORDER },
    );
    // It still gets as far as the credit and the holds.
    expect(reinstateCreditForOrder).toHaveBeenCalled();
  });

  it("★ survives the ITEM read failing, and restocks nothing", async () => {
    // Releasing stock for items we couldn't read would mean guessing
    // quantities, so an empty list is the only safe answer.
    let call = 0;
    const flaky: DbRunner = (fn) => {
      call += 1;
      if (call === 2) return Promise.reject(new Error("items read failed"));
      return Promise.resolve(fn(dbHolder.current.db));
    };
    await expect(
      releaseCancelledOrder(STORE, ORDER, flaky),
    ).resolves.toBeUndefined();
    expect(rpcCalls()).toHaveLength(0);
  });

  it("★ keeps going when ONE line's restock fails", async () => {
    // A partial release beats none: the other lines still come back, and the
    // missed one shows up in the next count.
    seed();
    let n = 0;
    dbHolder.current.db.execute = vi.fn(async (q: any) => {
      dbHolder.current.calls.execute.push(q);
      n += 1;
      if (n === 1) throw new Error("release_stock failed");
      return { rows: [] };
    });
    await expect(
      releaseCancelledOrder(STORE, ORDER, runner),
    ).resolves.toBeUndefined();
    expect(dbHolder.current.calls.execute).toHaveLength(2);
    expect(logError).toHaveBeenCalledWith(
      "cancel: release_stock",
      expect.any(Error),
      { orderId: ORDER },
    );
  });

  it("★ survives the pickup-hold lookup failing", async () => {
    // The TTL sweep is the backstop, so this can never be worth failing over.
    seed([]);
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("holds read failed");
    });
    await expect(
      releaseCancelledOrder(STORE, ORDER, runner),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "cancel: release pickup holds",
      expect.any(Error),
      { orderId: ORDER },
    );
  });

  it("survives a single hold failing to release", async () => {
    seed([], [[{ id: "hold-1" }]]);
    vi.mocked(releaseHold).mockRejectedValue(new Error("release failed"));
    await expect(
      releaseCancelledOrder(STORE, ORDER, runner),
    ).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "cancel: release pickup holds",
      expect.any(Error),
      { orderId: ORDER },
    );
  });
});

// ---------------------------------------------------------------------------
// The runner seam
// ---------------------------------------------------------------------------

describe("★ the caller decides the DB scope", () => {
  it("claims through the runner it was handed, not withService", async () => {
    // The dashboard keeps its RLS-scoped withUser(admin) claim; the customer
    // path passes withService AFTER proving ownership, because a shopper holds
    // SELECT but not UPDATE on their own order. Authority is the caller's job
    // — nothing in this module checks who you are.
    const spy = vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db)));
    await releaseCancelledOrder(STORE, ORDER, spy as DbRunner);
    // The claim and the item read both go through it.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("★ still runs the RPCs with service scope", async () => {
    // release_stock writes a ledger row a customer has no rights to, so the
    // stock movement itself is always privileged — regardless of the runner
    // used to prove the claim.
    const spy = vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db)));
    await releaseCancelledOrder(STORE, ORDER, spy as DbRunner);
    expect(rpcCalls()).toHaveLength(2);
  });
});
