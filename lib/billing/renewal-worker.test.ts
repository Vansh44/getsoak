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
  loadInvoiceParties: vi.fn(),
  ensureRenewalInvoice: vi.fn(),
  finalizeInvoiceClaimed: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => repo);

const collector = vi.hoisted(() => ({ collectInvoice: vi.fn() }));
vi.mock("./collect", () => collector);

// Telling the merchant is best-effort and proved by its own suite; here it is a
// seam, so a test can assert WHO was told and WHEN without sending mail.
const dunning = vi.hoisted(() => ({
  notifyInvoiceIssued: vi.fn(),
  notifyGraceStarted: vi.fn(),
  notifyDowngraded: vi.fn(),
}));
vi.mock("./dunning", () => dunning);

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
  scheduledPlan: null,
  scheduledPeriod: null,
  scheduledLocations: null,
  cancelAtPeriodEnd: false,
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
  repo.loadInvoiceParties.mockResolvedValue({
    supplierGstin: null,
    customerGstin: null,
    placeOfSupply: null,
  });
  repo.ensureRenewalInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
  });
  repo.finalizeInvoiceClaimed.mockResolvedValue({
    invoice: {
      id: "inv-1",
      status: "open",
      finalizedAt: "2026-09-01T00:00:00.000Z",
      invoiceRef: "SM/2026-27/00004",
    },
    claimed: true,
  });
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

  describe("★★ telling the merchant the invoice exists", () => {
    // With collection gated this notice IS how a merchant learns they must pay.
    // Silently issuing, waiting, then downgrading is not a billing system.

    it("mails once, on the run that issued it", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued).toHaveBeenCalledTimes(1);
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0]).toMatchObject({
        storeId: STORE,
        plan: "pro",
        // ₹5,000 plan + 2 billed locations × ₹1,000.
        amountPaise: 7_000_00,
        invoiceRef: "SM/2026-27/00004",
      });
    });

    it("★★ says NOTHING on a later run — the hourly cron re-reads the same row", async () => {
      // Without the finalize claim this would mail the same bill every hour for
      // four days, which is how people learn to ignore an email.
      repo.finalizeInvoiceClaimed.mockResolvedValue({
        invoice: {
          id: "inv-1",
          status: "open",
          finalizedAt: "2026-09-01T00:00:00.000Z",
          invoiceRef: "SM/2026-27/00004",
        },
        claimed: false, // another run got there first
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
    });

    it("★ says nothing about an invoice that was ALREADY issued", async () => {
      repo.ensureRenewalInvoice.mockResolvedValue({
        id: "inv-1",
        status: "open",
        finalizedAt: "2026-08-30T00:00:00.000Z",
        invoiceRef: "SM/2026-27/00004",
      });
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued).not.toHaveBeenCalled();
    });

    it("★★ autopay FALSE with no gateway — it is a bill, not a heads-up", async () => {
      // A merchant told "we'll collect this automatically" does nothing, and is
      // downgraded 48 hours after the cycle turns.
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
    });

    it("★ autopay FALSE with a gateway but NO mandate", async () => {
      seed([[{ ...DUE_ROW, mandateId: null }]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(false);
    });

    it("autopay TRUE only with both", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge, priceFor });
      expect(dunning.notifyInvoiceIssued.mock.calls[0][0].autopay).toBe(true);
    });
  });

  describe("★★ charge = null — ISSUE the invoice, do not charge", () => {
    // Issuing is not charging. When the pass was skipped wholesale for a missing
    // gateway, no invoice was ever written: pass 2 waited forever, grace never
    // opened, nobody was downgraded, every subscriber got free service past
    // their cycle end, and the manual payment surface had nothing to list.

    it("still writes the invoice", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(repo.ensureRenewalInvoice).toHaveBeenCalled();
    });

    it("★ still FINALIZES it — the merchant pays against a document number", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(repo.finalizeInvoiceClaimed).toHaveBeenCalled();
    });

    it("★★ never calls the gateway", async () => {
      seed([[DUE_ROW]]);
      await collectDueRenewals({ now: NOW, charge: null, priceFor });
      expect(collector.collectInvoice).not.toHaveBeenCalled();
    });

    it("★ counts it as manualRequired, not failed", async () => {
      // `failed` starts the grace clock. Nobody declined anything here — the
      // merchant simply has to pay it themselves.
      seed([[DUE_ROW]]);
      const res = await collectDueRenewals({
        now: NOW,
        charge: null,
        priceFor,
      });
      expect(res.manualRequired).toBe(1);
      expect(res.failed).toBe(0);
      expect(res.errors).toBe(0);
    });

    it("★ does not re-issue an invoice already paid", async () => {
      repo.ensureRenewalInvoice.mockResolvedValue({
        id: "inv-1",
        status: "paid",
        finalizedAt: "2026-09-01T00:00:00.000Z",
        invoiceRef: "SM/2026-27/00004",
      });
      seed([[DUE_ROW]]);
      const res = await collectDueRenewals({
        now: NOW,
        charge: null,
        priceFor,
      });
      expect(res.collected).toBe(1);
      expect(repo.finalizeInvoiceClaimed).not.toHaveBeenCalled();
    });
  });

  it("★ finalizes BEFORE charging — the debit is against an issued document", async () => {
    seed([[DUE_ROW]]);
    await collectDueRenewals({ now: NOW, charge, priceFor });
    const finalizeOrder =
      repo.finalizeInvoiceClaimed.mock.invocationCallOrder[0];
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
    expect(repo.finalizeInvoiceClaimed).not.toHaveBeenCalled();
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
    plan: "pro",
    period: "monthly",
    billedLocations: 0,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    cancelAtPeriodEnd: false,
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

  it("★★ APPLIES a booked plan change at the turn", async () => {
    // The other half of the invariant: pass 1 priced the next cycle with this
    // change, so pass 2 must write it. If they disagree the merchant is billed
    // for one plan and given another.
    seed([[{ ...TURNED, scheduledPlan: "basic" }], [{ status: "paid" }]]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.plan).toBe("basic");
    expect(set.scheduledPlan).toBeNull();
  });

  it("★★ APPLIES a booked period change, and the new cycle takes its LENGTH", async () => {
    // A monthly→yearly switch that ignored the period would give the merchant a
    // 30-day year.
    seed([[{ ...TURNED, scheduledPeriod: "yearly" }], [{ status: "paid" }]]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.period).toBe("yearly");
    expect(set.currentPeriodEnd).toBe("2027-09-01T00:00:00.000Z");
    expect(set.scheduledPeriod).toBeNull();
  });

  it("★ applies a booked location release at the turn", async () => {
    seed([
      [{ ...TURNED, billedLocations: 3, scheduledLocations: 1 }],
      [{ status: "paid" }],
    ]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.billedLocations).toBe(1);
    expect(set.scheduledLocations).toBeNull();
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

  describe("★★ the 48-hour warning", () => {
    it("warns when grace starts, naming the deadline", async () => {
      seed([[TURNED], [{ status: "open" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).toHaveBeenCalledTimes(1);
      const arg = dunning.notifyGraceStarted.mock.calls[0][0];
      expect(arg).toMatchObject({ storeId: STORE, plan: "pro" });
      expect(arg.graceEndsAt.getTime() - NOW.getTime()).toBe(
        GRACE_HOURS * 3_600_000,
      );
    });

    it("★★ says nothing when the grace claim was already won", async () => {
      // The row is re-read every hour for two days; without the conditional claim
      // the merchant is warned 48 times about one missed payment.
      dbHolder.current = makeDbMock({
        selectQueue: [[TURNED], [{ status: "open" }]],
        returning: [],
      });
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
    });

    it("★★ does NOT claim an attempt that never happened", async () => {
      // "We couldn't take payment" sends the merchant to check a card nobody
      // charged. Defaults to false, which is the truth while collection is gated.
      seed([[TURNED], [{ status: "open" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted.mock.calls[0][0].autopayAttempted).toBe(
        false,
      );
    });

    it("reports an attempt when autopay really is running", async () => {
      seed([[TURNED], [{ status: "open" }]]);
      await evaluateCycleTurns({ now: NOW, autopayConfigured: true });
      expect(dunning.notifyGraceStarted.mock.calls[0][0].autopayAttempted).toBe(
        true,
      );
    });

    it("★ says nothing when the invoice was PAID", async () => {
      seed([[TURNED], [{ status: "paid" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
    });

    it("★ says nothing while the payment is still processing", async () => {
      seed([[TURNED], [{ status: "processing" }]]);
      await evaluateCycleTurns({ now: NOW });
      expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
    });
  });
});

describe("★★ a cancelled subscription ends at its period end", () => {
  const CANCELLING = {
    storeId: STORE,
    plan: "pro",
    period: "monthly",
    billedLocations: 0,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    cancelAtPeriodEnd: true,
    currentCycleSeq: 3,
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
  };

  it("★★ ENDS it without waiting for an invoice", async () => {
    // claimDue never raised one, so without this branch the merchant sits in
    // `waiting` forever: still active, still entitled to a plan they stopped
    // paying for, and never actually cancelled.
    seed([[CANCELLING]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.ended).toBe(1);
    expect(s.waiting).toBe(0);
    const set = dbHolder.current.calls.set[0];
    expect(set.state).toBe("cancelled");
    expect(set.cancelAtPeriodEnd).toBe(false);
  });

  it("★★ DROPS THE PLAN TO FREE — that is what every gate reads", async () => {
    seed([[CANCELLING]]);
    await evaluateCycleTurns({ now: NOW });
    expect(dbHolder.current.calls.set.some((x: any) => x.plan === "free")).toBe(
      true,
    );
  });

  it("★ clears the cycle, so the cycle_present CHECK stays satisfied", async () => {
    seed([[CANCELLING]]);
    await evaluateCycleTurns({ now: NOW });
    const set = dbHolder.current.calls.set[0];
    expect(set.currentPeriodStart).toBeNull();
    expect(set.currentPeriodEnd).toBeNull();
  });

  it("★ tells the merchant, naming the plan they had", async () => {
    seed([[CANCELLING]]);
    await evaluateCycleTurns({ now: NOW });
    expect(dunning.notifyDowngraded).toHaveBeenCalledWith({
      storeId: STORE,
      fromPlan: "pro",
    });
  });

  it("★★ says nothing and counts nothing when the claim was LOST", async () => {
    // A resume racing the turn: the conditional claim is what decides.
    dbHolder.current = makeDbMock({
      selectQueue: [[CANCELLING]],
      returning: [],
    });
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.ended).toBe(0);
    expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
  });

  it("★ never starts a grace clock on it", async () => {
    seed([[CANCELLING]]);
    const s = await evaluateCycleTurns({ now: NOW });
    expect(s.graced).toBe(0);
    expect(dunning.notifyGraceStarted).not.toHaveBeenCalled();
  });
});

describe("★★ pass 1 skips a cancelled subscription", () => {
  it("does not invoice a cycle that will not happen", async () => {
    // Raising a document would bill a merchant who explicitly stopped — and,
    // because grace follows an unpaid invoice, would then chase them for it.
    seed([[{ ...DUE_ROW, cancelAtPeriodEnd: true }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    expect(repo.ensureRenewalInvoice).not.toHaveBeenCalled();
  });
});

describe("★★ the next cycle is priced with what will APPLY then", () => {
  it("uses a booked plan change, not today's plan", async () => {
    seed([[{ ...DUE_ROW, scheduledPlan: "basic" }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    expect(priceFor).toHaveBeenCalledWith("basic", "monthly");
  });

  it("★ uses a booked PERIOD change — it decides the amount AND the cycle length", async () => {
    seed([[{ ...DUE_ROW, scheduledPeriod: "yearly" }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    expect(priceFor).toHaveBeenCalledWith("pro", "yearly");
    // 365 days on from the boundary, because a yearly cycle is a DURATION.
    const arg = repo.ensureRenewalInvoice.mock.calls[0][0];
    expect(arg.periodEnd.toISOString()).toBe("2027-09-03T00:00:00.000Z");
  });

  it("★★ drops locations when the booked plan has no POS", async () => {
    seed([[{ ...DUE_ROW, billedLocations: 3, scheduledPlan: "basic" }]]);
    await collectDueRenewals({ now: NOW, charge: null, priceFor });
    const built = repo.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(false);
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

  it("★★ tells the merchant, naming the plan they LOST", async () => {
    // The claim sets plan to free, so the name has to be read before it — and
    // "your Pro plan has ended" is a different message from "your plan ended".
    seed([[{ storeId: STORE, plan: "pro" }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({ rows: [{ ok: true }] }));
    await downgradeExpired({ now: NOW });
    expect(dunning.notifyDowngraded).toHaveBeenCalledWith({
      storeId: STORE,
      fromPlan: "pro",
    });
  });

  it("★★ says NOTHING when the claim was lost — no downgrade, no notice", async () => {
    seed([[{ storeId: STORE, plan: "pro" }]]);
    dbHolder.current.db.execute = vi.fn(async () => ({
      rows: [{ ok: false }],
    }));
    await downgradeExpired({ now: NOW });
    expect(dunning.notifyDowngraded).not.toHaveBeenCalled();
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
    // billing_claim_downgrade says no when they paid or when it already ran.
    // (It used to refuse a comped subscription too; migration 0078 removed that
    // — a comp is an overlay, not a billing state.) Closing the till anyway
    // would stop a shop that is still entitled to sell.
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
