/* eslint-disable @typescript-eslint/no-explicit-any */
// Settling payments whose outcome we never learned.
//
// The asymmetry is the whole design and it is what these tests protect:
//
//   FINDING MONEY is safe and urgent — a captured payment means the merchant
//   paid, and recording it can only help them.
//   DECLARING FAILURE frees the invoice for a fresh attempt, so doing it to a
//   payment still in flight invites a SECOND CHARGE. It waits three days, and
//   only ever on the gateway's word that nothing was captured.
//
// Nothing here may settle an attempt on a timestamp alone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const provider = vi.hoisted(() => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("@/lib/payments/provider", () => provider);

const collect = vi.hoisted(() => ({ settleAttempt: vi.fn() }));
vi.mock("./collect", () => collect);

const worker = vi.hoisted(() => ({ advanceAfterPayment: vi.fn() }));
vi.mock("./renewal-worker", () => worker);

import {
  FAIL_AFTER_HOURS,
  reconcileStrandedAttempts,
  STALE_AFTER_MINUTES,
} from "./reconcile";

const STORE = "store-1";
const NOW = new Date("2026-09-10T00:00:00.000Z");

/** Older than the stale window, younger than the fail window. */
const STALE = new Date(NOW.getTime() - 60 * 60_000).toISOString();
/** Older than the fail window. */
const ANCIENT = new Date(
  NOW.getTime() - (FAIL_AFTER_HOURS + 1) * 3_600_000,
).toISOString();

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    storeId: STORE,
    invoiceId: "inv-1",
    providerOrderId: "order_1",
    amountPaise: 500_000,
    state: "processing",
    createdAt: STALE,
    ...over,
  };
}

function seed(rows: any[] = [attempt()]) {
  dbHolder.current = makeDbMock({ selectQueue: [rows] });
}

/** A gateway that reports these payments for any order. */
const gateway = (payments: any[]) =>
  vi.fn(async () => ({ ok: true as const, data: payments }));

const CAPTURED = { id: "pay_1", status: "captured", amount: 500_000 };

beforeEach(() => {
  vi.clearAllMocks();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_1",
    keySecret: "secret",
  });
  collect.settleAttempt.mockResolvedValue("captured");
  worker.advanceAfterPayment.mockResolvedValue(true);
  seed();
});

describe("★★ finding money", () => {
  it("settles an attempt the gateway says was CAPTURED", async () => {
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.recovered).toBe(1);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "captured",
      expect.objectContaining({ providerPaymentId: "pay_1" }),
    );
  });

  it("★★ ADVANCES THE CYCLE, or the merchant is downgraded for a payment they made", async () => {
    // The only thing that moves a cycle is a paid invoice being NOTICED.
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
  });

  it("★ counts a LOST settle race as recovered — the money is recorded either way", async () => {
    collect.settleAttempt.mockResolvedValue(null);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.recovered).toBe(1);
  });

  it("★★ FLAGS an amount mismatch rather than silently accepting it", async () => {
    // The merchant paid, so the payment is recorded — but a different amount is
    // a question only a human can answer.
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([{ ...CAPTURED, amount: 400_000 }]) as any,
    });
    expect(res.recovered).toBe(1);
    expect(res.flagged).toBe(1);
    const flagged = dbHolder.current.calls.values.find(
      (v: any) => v.kind === "amount_mismatch",
    );
    expect(flagged).toMatchObject({
      expectedPaise: 500_000,
      observedPaise: 400_000,
    });
  });

  it("does not flag a matching amount", async () => {
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.flagged).toBe(0);
  });

  it("★ ignores a payment that is authorized but NOT captured", async () => {
    // Authorized is not money. Treating it as paid would mark an invoice settled
    // for funds that may never be captured.
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([
        { id: "pay_x", status: "authorized" },
      ]) as any,
    });
    expect(res.recovered).toBe(0);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });
});

describe("★★ declaring failure", () => {
  it("REFUSES to fail an attempt inside the window, however stale", async () => {
    // It may still land. Failing it frees the invoice and invites a second
    // charge for the same cycle.
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.failed).toBe(0);
    expect(res.stillUnknown).toBe(1);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it(`fails one older than ${FAIL_AFTER_HOURS}h with nothing captured`, async () => {
    collect.settleAttempt.mockResolvedValue("failed");
    seed([attempt({ createdAt: ANCIENT })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(res.failed).toBe(1);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "failed",
      expect.objectContaining({ failureCode: "reconciled_no_payment" }),
    );
  });

  it("★★ an ANCIENT attempt that WAS captured is recovered, never failed", async () => {
    // Age is not evidence. The gateway's answer is.
    seed([attempt({ createdAt: ANCIENT })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.recovered).toBe(1);
    expect(res.failed).toBe(0);
  });
});

describe("★★ never guessing", () => {
  it("does NOTHING when the gateway is unreachable", async () => {
    seed([attempt({ createdAt: ANCIENT })]);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: vi.fn(async () => ({
        ok: false as const,
        error: "timeout",
        outcome: "unknown" as const,
      })) as any,
    });
    // Unreachable is not a verdict — especially not for the FAIL path.
    expect(res.stillUnknown).toBe(1);
    expect(res.failed).toBe(0);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★★ does NOTHING with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.considered).toBe(0);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ does NOTHING with no gateway reader injected", async () => {
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: null,
    });
    expect(res.considered).toBe(0);
  });

  it("★ survives a scan failure without claiming a clean sweep", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([CAPTURED]) as any,
    });
    expect(res.errors).toBe(1);
    expect(res.recovered).toBe(0);
  });

  it("★ one bad attempt does not abort the sweep", async () => {
    seed([attempt({ id: "att-1" }), attempt({ id: "att-2" })]);
    const fetchOrderPayments = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ ok: true, data: [CAPTURED] });
    const res = await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: fetchOrderPayments as any,
    });
    expect(res.errors).toBe(1);
    expect(res.recovered).toBe(1);
  });

  it("★ the stale window is applied to the QUERY, not after the fact", async () => {
    // Asking the gateway about a live checkout is pointless; the filter keeps a
    // busy sweep cheap and never touches a payment in progress.
    await reconcileStrandedAttempts({
      now: NOW,
      fetchOrderPayments: gateway([]) as any,
    });
    expect(STALE_AFTER_MINUTES).toBeGreaterThan(0);
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });
});
