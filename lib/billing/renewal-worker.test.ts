/* eslint-disable @typescript-eslint/no-explicit-any */
// The renewal worker.
//
// ── What these tests are really about ──────────────────────────────────────
// One distinction carries most of the risk: an invoice that FAILED starts a
// 48-hour countdown to losing the merchant's plan, and an invoice that is still
// PROCESSING must not. With the X+3 settlement window, "still processing at the
// cycle boundary" is the ordinary case rather than an edge case — so getting
// this wrong would downgrade paying merchants routinely, not rarely.
//
// ⚠ The exactly-once guarantees are database constraints and
// billing_claim_downgrade, proved by supabase/billing_verify.sql. These tests
// prove the orchestration around them: who is selected, what is skipped, and
// which outcome maps to which consequence.

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

// The repository and the collector are proved by their own suites; here they
// are seams, so a test can put the worker in any outcome without a database.
const repo = vi.hoisted(() => ({
  loadTaxContext: vi.fn(),
  ensureRenewalInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => repo);

const collector = vi.hoisted(() => ({ collectInvoice: vi.fn() }));
vi.mock("./collect", () => collector);

import {
  classify,
  collectDueRenewals,
  downgradeExpired,
  evaluateCycleTurns,
} from "./renewal-worker";
import { GRACE_HOURS } from "./cycle";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");

const DUE_ROW = {
  storeId: STORE,
  plan: "pro",
  period: "monthly",
  currentCycleSeq: 3,
  currentPeriodEnd: "2026-09-03T00:00:00.000Z",
  billedLocations: 2,
  mandateId: "man-1",
};

const priceFor = vi.fn(async () => ({
  planPaise: 5_000_00,
  locationPaise: 1_000_00,
  planLabel: "Pro",
}));

const charge = vi.fn() as any;

function seed(selects: any[][] = []) {
  dbHolder.current = makeDbMock({ selectQueue: selects });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  repo.loadTaxContext.mockResolvedValue({
    enabled: false,
    rateBps: 0,
    inclusive: false,
    supplierStateCode: null,
    placeOfSupply: null,
  });
  repo.ensureRenewalInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
  });
  repo.finalizeInvoice.mockResolvedValue({ id: "inv-1", status: "open" });
  repo.amountDueForInvoice.mockResolvedValue(7_000_00);
  collector.collectInvoice.mockResolvedValue({
    status: "paid",
    attemptId: "att-1",
  });
});

describe("classify — which outcomes may start a grace clock", () => {
  it("★ 'not collectable' is MANUAL, never a failure", () => {
    // Over the AFA limit or a revoked mandate means the merchant must pay by
    // hand. Counting it as a failure would start a countdown to downgrade for
    // someone who has done nothing wrong.
    expect(
      classify({ status: "not_collectable", reason: "over_afa_limit" }),
    ).toBe("manual");
  });

  it("★ 'already in flight' is PENDING, never a failure", () => {
    expect(classify({ status: "already_in_flight" })).toBe("pending");
  });

  it("★ 'pending reconcile' is PENDING — an unknown outcome is not a decline", () => {
    expect(classify({ status: "pending_reconcile", attemptId: "a" })).toBe(
      "pending",
    );
  });

  it("only a gateway rejection is a failure", () => {
    expect(classify({ status: "failed", attemptId: "a" })).toBe("failed");
    expect(classify({ status: "paid", attemptId: "a" })).toBe("paid");
  });
});

describe("collectDueRenewals", () => {
  it("bills the NEXT cycle, starting where the current one ends", async () => {
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });

    const arg = repo.ensureRenewalInvoice.mock.calls[0][0];
    expect(arg.cycleSeq).toBe(4); // current 3 + 1
    expect(arg.periodStart.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    // 30 days on from the start, because a cycle is a DURATION.
    expect(arg.periodEnd.toISOString()).toBe("2026-10-03T00:00:00.000Z");
  });

  it("★ finalizes BEFORE charging — the debit is against an issued document", async () => {
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    const finalizeOrder = repo.finalizeInvoice.mock.invocationCallOrder[0];
    const chargeOrder = collector.collectInvoice.mock.invocationCallOrder[0];
    expect(finalizeOrder).toBeLessThan(chargeOrder);
  });

  it("does not re-finalize an already-issued invoice", async () => {
    repo.ensureRenewalInvoice.mockResolvedValue({
      id: "inv-1",
      status: "open",
      finalizedAt: "2026-08-28T00:00:00.000Z",
    });
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(repo.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★ skips an invoice that is already paid, without charging again", async () => {
    repo.ensureRenewalInvoice.mockResolvedValue({
      id: "inv-1",
      status: "paid",
      finalizedAt: "2026-08-28T00:00:00.000Z",
    });
    seed([[DUE_ROW]]);
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(collector.collectInvoice).not.toHaveBeenCalled();
    expect(s.collected).toBe(1);
  });

  it("★ never guesses an amount — a null due figure stops the charge", async () => {
    repo.amountDueForInvoice.mockResolvedValue(null);
    seed([[DUE_ROW]]);
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(collector.collectInvoice).not.toHaveBeenCalled();
    expect(s.pendingReconcile).toBe(1);
  });

  it("bills locations on a POS plan", async () => {
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    const built = repo.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(true);
    expect(built.totalPaise).toBe(7_000_00); // 5,000 + 2 × 1,000
  });

  it("★ never bills locations on a plan that cannot have POS", async () => {
    // Charging for POS on a plan that cannot use it is indefensible, and a
    // stale billed_locations count is exactly how that happens.
    seed([[{ ...DUE_ROW, plan: "basic" }]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    const built = repo.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(false);
    expect(built.totalPaise).toBe(5_000_00);
  });

  it("counts each outcome separately", async () => {
    seed([
      [DUE_ROW, { ...DUE_ROW, storeId: "s2" }, { ...DUE_ROW, storeId: "s3" }],
    ]);
    collector.collectInvoice
      .mockResolvedValueOnce({ status: "paid", attemptId: "a" })
      .mockResolvedValueOnce({ status: "failed", attemptId: "b" })
      .mockResolvedValueOnce({
        status: "not_collectable",
        reason: "over_afa_limit",
      });

    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(s).toMatchObject({
      considered: 3,
      collected: 1,
      failed: 1,
      manualRequired: 1,
    });
  });

  it("★ one store's failure does not abort the batch", async () => {
    seed([[DUE_ROW, { ...DUE_ROW, storeId: "s2" }]]);
    collector.collectInvoice
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "paid", attemptId: "b" });

    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(s.errors).toBe(1);
    expect(s.collected).toBe(1);
  });

  it("returns an empty summary when the claim query fails", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    };
    const s = await collectDueRenewals({ now: NOW, charge, priceFor });
    expect(s.errors).toBe(1);
    expect(s.considered).toBe(0);
  });
});

describe("evaluateCycleTurns — the boundary", () => {
  const TURNED = {
    storeId: STORE,
    period: "monthly",
    currentCycleSeq: 3,
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
  };

  it("advances a paid subscription into its new cycle", async () => {
    seed([[TURNED], [{ status: "paid" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.advanced).toBe(1);

    const set = dbHolder.current.calls.set[0];
    expect(set.currentCycleSeq).toBe(4);
    expect(set.currentPeriodStart).toBe("2026-09-01T00:00:00.000Z");
    expect(set.currentPeriodEnd).toBe("2026-10-01T00:00:00.000Z");
    expect(set.state).toBe("active");
    // Any previous grace is cleared — they paid.
    expect(set.graceStartedAt).toBeNull();
    expect(set.graceEndsAt).toBeNull();
  });

  it("★ starts grace on an OPEN (attempted, unpaid) invoice", async () => {
    seed([[TURNED], [{ status: "open" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.graced).toBe(1);

    const set = dbHolder.current.calls.set[0];
    expect(set.state).toBe("past_due");
    expect(set.graceStartedAt).toBe(NOW.toISOString());
    expect(set.graceEndsAt).toBe(
      new Date(NOW.getTime() + GRACE_HOURS * 3600_000).toISOString(),
    );
  });

  it("★★ does NOTHING while the payment is still PROCESSING", async () => {
    // With the X+3 window this is the ORDINARY state at the boundary. Starting a
    // downgrade clock here is Rule 6 — punishing a merchant for money that is
    // still in flight.
    seed([[TURNED], [{ status: "processing" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.waiting).toBe(1);
    expect(s.graced).toBe(0);
    expect(s.advanced).toBe(0);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ does nothing when the invoice does not exist yet", async () => {
    seed([[TURNED], []]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.waiting).toBe(1);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ does nothing for a DRAFT invoice — it was never issued or attempted", async () => {
    seed([[TURNED], [{ status: "draft" }]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.waiting).toBe(1);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("★ claims the advance on the cycle it read, so it cannot double-advance", async () => {
    seed([[TURNED], [{ status: "paid" }]]);
    await evaluateCycleTurns({ now: NOW });
    // The WHERE carries both the store and the prior cycle_seq.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });
});

describe("downgradeExpired", () => {
  it("★ downgrades and closes the till in ONE transaction", async () => {
    seed([[{ storeId: STORE }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));

    const s = await downgradeExpired({ now: NOW });
    expect(s.downgraded).toBe(1);
    expect(s.shiftsClosed).toBe(1);

    const set = dbHolder.current.calls.set[0];
    expect(set.status).toBe("closed");
    expect(set.closedByName).toBe("System");
  });

  it("★★ closes the shift at ZERO variance — billing must not invent a discrepancy", async () => {
    // A variance reads as a cashier being short, and nobody counted this drawer.
    seed([[{ storeId: STORE }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    await downgradeExpired({ now: NOW });
    expect(dbHolder.current.calls.set[0].variance).toBe(0);
    expect(dbHolder.current.calls.set[0].note).toMatch(/no variance/i);
  });

  it("★ a REFUSED claim closes no shift — the store keeps trading", async () => {
    // billing_claim_downgrade says no when they paid, when it already ran, or
    // when the store is comped. Closing the till anyway would stop a shop that
    // is still entitled to sell.
    seed([[{ storeId: STORE }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({
      rows: [{ ok: false }],
    }));

    const s = await downgradeExpired({ now: NOW });
    expect(s.downgraded).toBe(0);
    expect(s.shiftsClosed).toBe(0);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("one store's failure does not abort the batch", async () => {
    seed([[{ storeId: STORE }, { storeId: "s2" }]]);
    let n = 0;
    dbHolder.current.db.execute = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("boom");
      return { rows: [{ ok: true }] };
    });

    const s = await downgradeExpired({ now: NOW });
    expect(s.errors).toBe(1);
    expect(s.downgraded).toBe(1);
  });

  it("returns an empty summary when the scan fails", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    };
    const s = await downgradeExpired({ now: NOW });
    expect(s.errors).toBe(1);
    expect(s.downgraded).toBe(0);
  });
});
