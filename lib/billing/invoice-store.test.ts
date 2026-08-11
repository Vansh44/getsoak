/* eslint-disable @typescript-eslint/no-explicit-any */
// The invoice repository.
//
// ── What these tests can and cannot prove ──────────────────────────────────
// The guarantees this module leans on live in POSTGRES, not here: exactly-once
// creation is the billing_invoices_one_per_cycle UNIQUE index, immutability is
// a trigger, and the document number comes from another trigger. None of that
// is verifiable against a mock — it is proved against a real database by
// supabase/billing_verify.sql (26/26 on staging).
//
// So what IS proved here is the layer around them: that a lost race reads the
// winner's invoice instead of creating a second obligation, that lines are
// written BEFORE finalization (the trigger freezes them after), that tax is
// snapshotted rather than referenced, and that nothing throws into a caller who
// is part-way through collecting money.

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

import { logError } from "@/lib/observability/logger";
import {
  amountDueForInvoice,
  createAiCreditsInvoice,
  ensureRenewalInvoice,
  finalizeInvoice,
  getInvoice,
  loadTaxContext,
} from "./invoice-store";
import { buildSubscriptionInvoice, type TaxContext } from "./invoice";

const STORE = "store-1";
const INVOICE = "inv-1";

const EXCLUSIVE: TaxContext = {
  enabled: true,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: "07",
  placeOfSupply: "29",
};

const BUILT = buildSubscriptionInvoice({
  planLabel: "Basic",
  period: "yearly",
  planPaise: 15_000_00,
  tax: EXCLUSIVE,
});

const INVOICE_ROW = {
  id: INVOICE,
  storeId: STORE,
  kind: "subscription",
  status: "draft",
  totalPaise: 17_700_00,
  cycleSeq: 1,
  invoiceRef: null,
  finalizedAt: null,
};

function seed(opts: { selects?: any[][]; returning?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: opts.selects ?? [],
    returning: opts.returning ?? [{ id: INVOICE }],
  });
}

function brokenDb() {
  dbHolder.current = {
    db: {
      select: () => {
        throw new Error("db down");
      },
      insert: () => {
        throw new Error("db down");
      },
      update: () => {
        throw new Error("db down");
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("loadTaxContext", () => {
  it("reads the platform settings and the merchant's place of supply", async () => {
    seed({
      selects: [
        [
          {
            taxEnabled: true,
            taxInclusive: true,
            taxRateBps: 1800,
            stateCode: "07",
          },
        ],
        [{ stateCode: "29" }],
      ],
    });
    expect(await loadTaxContext(STORE)).toEqual({
      enabled: true,
      rateBps: 1800,
      inclusive: true,
      supplierStateCode: "07",
      placeOfSupply: "29",
    });
  });

  it("★ falls back to tax OFF when settings are missing", async () => {
    seed({ selects: [[], []] });
    expect(await loadTaxContext(STORE)).toMatchObject({
      enabled: false,
      rateBps: 0,
    });
  });

  it("★ falls back to tax OFF on a read failure, never inventing a charge", async () => {
    brokenDb();
    const ctx = await loadTaxContext(STORE);
    expect(ctx.enabled).toBe(false);
    expect(logError).toHaveBeenCalled();
  });

  it("leaves place of supply null when the store has no billing account", async () => {
    seed({
      selects: [
        [
          {
            taxEnabled: true,
            taxInclusive: false,
            taxRateBps: 1800,
            stateCode: "07",
          },
        ],
        [],
      ],
    });
    expect((await loadTaxContext(STORE)).placeOfSupply).toBeNull();
  });
});

describe("ensureRenewalInvoice", () => {
  const args = {
    storeId: STORE,
    cycleSeq: 1,
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    built: BUILT,
  };

  it("writes the invoice with the built totals, as a DRAFT", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    const row = await ensureRenewalInvoice(args);
    expect(row?.id).toBe(INVOICE);

    const values = dbHolder.current.calls.values[0];
    expect(values).toMatchObject({
      storeId: STORE,
      kind: "subscription",
      status: "draft",
      cycleSeq: 1,
      subtotalPaise: 15_000_00,
      taxPaise: 2_700_00,
      totalPaise: 17_700_00,
    });
  });

  it("★ snapshots the tax RATE onto the invoice, not a reference to settings", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice(args);
    expect(dbHolder.current.calls.values[0].taxRateBps).toBe(1800);
  });

  it("★ writes the lines BEFORE finalization — the trigger freezes them after", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice(args);
    // Two inserts: the invoice, then its lines. Nothing sets finalized_at here.
    expect(dbHolder.current.calls.values).toHaveLength(2);
    const lines = dbHolder.current.calls.values[1];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.map((l: any) => l.kind)).toEqual(["base_plan", "tax"]);
    expect(dbHolder.current.calls.values[0].finalizedAt).toBeUndefined();
  });

  it("orders the lines so a printed invoice is stable", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    await ensureRenewalInvoice(args);
    expect(
      dbHolder.current.calls.values[1].map((l: any) => l.sortOrder),
    ).toEqual([0, 1]);
  });

  it("★★ a LOST RACE reads the winner's invoice, never creating a second one", async () => {
    // onConflictDoNothing returned no row: someone else inserted this cycle.
    seed({ returning: [], selects: [[{ ...INVOICE_ROW, id: "inv-winner" }]] });
    const row = await ensureRenewalInvoice(args);
    expect(row?.id).toBe("inv-winner");
    // Only the invoice insert was attempted — no lines for an invoice we did
    // not create, which would attach duplicates to the winner's document.
    expect(dbHolder.current.calls.values).toHaveLength(1);
  });

  it("returns null when the race is lost AND the winner cannot be read", async () => {
    seed({ returning: [], selects: [[]] });
    expect(await ensureRenewalInvoice(args)).toBeNull();
  });

  it("★ never throws into a caller mid-collection; logs and returns null", async () => {
    brokenDb();
    expect(await ensureRenewalInvoice(args)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("createAiCreditsInvoice", () => {
  const built = buildSubscriptionInvoice({
    planLabel: "x",
    period: "monthly",
    planPaise: 129_00,
    tax: EXCLUSIVE,
  });

  it("★ carries NO cycle_seq, so credits never collide with a renewal", async () => {
    seed({
      selects: [[{ ...INVOICE_ROW, kind: "ai_credits", cycleSeq: null }]],
    });
    await createAiCreditsInvoice({ storeId: STORE, built });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      kind: "ai_credits",
      cycleSeq: null,
    });
  });

  it("returns null and logs on failure", async () => {
    brokenDb();
    expect(await createAiCreditsInvoice({ storeId: STORE, built })).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("finalizeInvoice", () => {
  it("★ claims on finalized_at IS NULL, so two callers cannot both issue it", async () => {
    seed({ selects: [[{ ...INVOICE_ROW, invoiceRef: "SM/2026-27/00001" }]] });
    const row = await finalizeInvoice(
      INVOICE,
      new Date("2026-08-28T00:00:00Z"),
    );
    expect(row?.invoiceRef).toBe("SM/2026-27/00001");

    const set = dbHolder.current.calls.set[0];
    expect(set.status).toBe("open");
    expect(set.finalizedAt).toBe("2026-08-28T00:00:00.000Z");
    // The claim predicate must be part of the WHERE, not a prior read.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("★ a lost claim is not an error — it returns the already-issued invoice", async () => {
    seed({ selects: [[{ ...INVOICE_ROW, invoiceRef: "SM/2026-27/00007" }]] });
    const row = await finalizeInvoice(INVOICE);
    expect(row?.invoiceRef).toBe("SM/2026-27/00007");
  });

  it("returns null and logs on failure", async () => {
    brokenDb();
    expect(await finalizeInvoice(INVOICE)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("amountDueForInvoice", () => {
  it("is the full total when no credit has been applied", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: 0 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(17_700_00);
  });

  it("★ subtracts applied credit without touching the invoice total", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: -5_000_00 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(12_700_00);
  });

  it("★ never goes negative when credit exceeds the invoice", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: -99_999_00 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(0);
  });

  it("handles credit stored with either sign", async () => {
    seed({ selects: [[INVOICE_ROW], [{ total: 5_000_00 }]] });
    expect(await amountDueForInvoice(INVOICE)).toBe(12_700_00);
  });

  it("returns null for an unknown invoice", async () => {
    seed({ selects: [[]] });
    expect(await amountDueForInvoice(INVOICE)).toBeNull();
  });

  it("★ returns null on a read failure rather than quoting the full total", async () => {
    // Guessing the full amount when credit may already be applied would
    // double-charge — the one outcome worth refusing to guess at (Rule 10).
    brokenDb();
    expect(await amountDueForInvoice(INVOICE)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});

describe("getInvoice", () => {
  it("returns the row", async () => {
    seed({ selects: [[INVOICE_ROW]] });
    expect((await getInvoice(INVOICE))?.id).toBe(INVOICE);
  });

  it("returns null and logs on failure", async () => {
    brokenDb();
    expect(await getInvoice(INVOICE)).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});
