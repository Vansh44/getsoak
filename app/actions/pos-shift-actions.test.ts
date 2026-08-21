/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/locations/scope", () => ({ getViewerLocations: vi.fn() }));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSettings: vi.fn(async () => ({ "pos.requireOpenShift": false })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { withService } from "@/lib/db/client";
import { resolvePosOperator } from "@/lib/pos/operator";
import {
  closeShift,
  currentShiftIdFor,
  getCurrentShift,
  openShift,
  recordCashMovement,
} from "./pos-shift-actions";
import { getShiftHistory, getShiftReport } from "./pos-shift-actions";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getViewerLocations } from "@/lib/locations/scope";

const actor = (role: "cashier" | "manager" | "owner") => ({
  role,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: role === "owner" ? null : "st1",
  name: role === "owner" ? "Owner" : "Priya",
  source: role === "owner" ? ("owner" as const) : ("operator" as const),
  deviceAuthorized: true,
});

/** loadReport's reads, in order: shift row, payments, movements, sale agg. */
const reportSeed = (over: any = {}) => [
  [
    {
      id: "sh1",
      status: "open",
      opened_at: "2026-07-27T09:00:00Z",
      opened_by_name: "Priya",
      opening_float: 2000,
      closed_at: null,
      closed_by_name: null,
      counted_cash: null,
      expected_cash: null,
      variance: null,
      note: null,
      location_name: "Main",
      ...over.shift,
    },
  ],
  over.payments ?? [],
  over.movements ?? [],
  over.agg ?? [{ n: 0, gross: 0 }],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(actor("manager") as any);
  dbHolder.current = makeDbMock();
});

describe("openShift", () => {
  it("refuses a cashier — they sell into the drawer, they don't declare it", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    const r = await openShift(2000);
    expect(r.error).toMatch(/manager or the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await openShift(2000)).error).toMatch(/signed in/i);
  });

  it("opens at the operator's OWN store and location", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "sh1" }] });
    const r = await openShift(2000);
    expect(r.success).toBe(true);
    // Never a client-supplied location.
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      locationId: "loc-1",
      openingFloat: 2000,
      openedByName: "Priya",
    });
  });

  it("rejects a nonsense float", async () => {
    expect((await openShift(-5)).error).toMatch(/valid opening float/i);
    expect((await openShift(NaN)).error).toMatch(/valid opening float/i);
    expect((await openShift(99_999_999)).error).toMatch(/valid opening float/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  // The partial unique index is the concurrency story; this is how the loser
  // of the race is told, rather than surfacing a raw constraint error.
  it("reports a friendly error when a shift is already open", async () => {
    vi.mocked(withService).mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "23505" }),
    );
    const r = await openShift(2000);
    expect(r.error).toMatch(/already open/i);
  });

  it("lets an owner with no staff id open one", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("owner") as any);
    dbHolder.current = makeDbMock({ returning: [{ id: "sh1" }] });
    expect((await openShift(0)).success).toBe(true);
    expect(dbHolder.current.calls.values[0].openedBy).toBeNull();
  });
});

describe("getCurrentShift", () => {
  it("returns no shift when none is open", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await getCurrentShift();
    expect(r.shift).toBeNull();
    expect(r.canManage).toBe(true);
  });

  it("computes live expected cash for an open shift", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "sh1" }],
        ...reportSeed({
          payments: [
            {
              order_id: "o1",
              method: "cash",
              amount: 500,
              change_due: 100,
            },
            { order_id: "o2", method: "card", amount: 300, change_due: null },
          ],
          movements: [
            {
              id: "m1",
              type: "drop",
              amount: 1000,
              reason: null,
              created_at: "x",
              created_by_name: "Priya",
            },
          ],
          agg: [{ n: 2, gross: 700 }],
        }),
      ],
    });
    const r = await getCurrentShift();
    // 2000 float + 400 net cash − 1000 drop
    expect(r.shift).toMatchObject({
      status: "open",
      openingFloat: 2000,
      cashSales: 400,
      drops: 1000,
      expectedCash: 1400,
      saleCount: 2,
    });
    // Card takings appear in the breakdown but never in expected CASH.
    expect(r.shift?.byMethod).toEqual({ cash: 400, card: 300 });
  });

  it("tells a cashier they cannot manage it", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await getCurrentShift()).canManage).toBe(false);
  });
});

describe("closeShift", () => {
  const seedOpen = (over: any = {}) =>
    (dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "sh1" }], ...reportSeed(over)],
      returning: [{ id: "sh1" }],
    }));

  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    expect((await closeShift(2000)).error).toMatch(/manager or the owner/i);
  });

  it("refuses when nothing is open", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await closeShift(2000)).error).toMatch(/no shift is open/i);
  });

  it("records a short drawer as a negative variance", async () => {
    seedOpen({
      payments: [
        { order_id: "o1", method: "cash", amount: 500, change_due: 100 },
      ],
    });
    // expected 2400, counted 2350
    const r = await closeShift(2350);
    expect(r.success).toBe(true);
    expect(r.expected).toBe(2400);
    expect(r.variance).toBe(-50);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "closed",
      countedCash: 2350,
      expectedCash: 2400,
      variance: -50,
      closedByName: "Priya",
    });
  });

  it("records an over drawer as a positive variance", async () => {
    seedOpen();
    const r = await closeShift(2075);
    expect(r.variance).toBe(75);
  });

  // Conditional claim: a second tap must not overwrite the first count.
  it("refuses to close a shift that was already closed", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "sh1" }], ...reportSeed()],
      returning: [],
    });
    expect((await closeShift(2000)).error).toMatch(/already closed/i);
  });

  it("rejects a nonsense count", async () => {
    expect((await closeShift(-1)).error).toMatch(/counted cash/i);
  });
});

describe("recordCashMovement", () => {
  const seedOpen = () =>
    (dbHolder.current = makeDbMock({ selectQueue: [[{ id: "sh1" }]] }));

  it("refuses a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(actor("cashier") as any);
    expect((await recordCashMovement("drop", 500)).error).toMatch(
      /manager or the owner/i,
    );
  });

  it("records a drop against the open shift", async () => {
    seedOpen();
    const r = await recordCashMovement("drop", 500, "  to safe  ");
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      shiftId: "sh1",
      storeId: "store-1",
      type: "drop",
      amount: 500,
      reason: "to safe",
    });
  });

  it("needs an open shift", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await recordCashMovement("drop", 500)).error).toMatch(
      /open a shift/i,
    );
  });

  it("rejects a bogus type or amount", async () => {
    seedOpen();
    expect((await recordCashMovement("skim" as any, 5)).error).toMatch(
      /invalid movement/i,
    );
    expect((await recordCashMovement("drop", 0)).error).toMatch(
      /valid amount/i,
    );
    expect((await recordCashMovement("drop", -5)).error).toMatch(
      /valid amount/i,
    );
  });
});

describe("currentShiftIdFor", () => {
  it("returns the open shift id", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "sh1" }]] });
    expect(await currentShiftIdFor("loc-1")).toBe("sh1");
  });

  it("returns null when none is open", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await currentShiftIdFor("loc-1")).toBeNull();
  });

  // A sale must never fail because the drawer lookup did — the sale just goes
  // unattributed, which reconciliation surfaces rather than hides.
  it("returns null rather than throwing when the read fails", async () => {
    vi.mocked(withService).mockRejectedValueOnce(new Error("connection reset"));
    await expect(currentShiftIdFor("loc-1")).resolves.toBeNull();
  });
});

// ── Dashboard shift reporting (roadmap Step 17) ─────────────────────────────
// These take DASHBOARD gates, not POS ones: listShifts above is bound to a POS
// operator's own location, which is right for a till and useless for an owner.
// The scoping is the security-critical half — loadReport reads a shift BY ID
// with no store predicate.

describe("getShiftHistory / getShiftReport — the gates", () => {
  const ADMIN = { uid: "admin-1", email: "owner@shop.test" };

  beforeEach(() => {
    vi.mocked(getManagerIdentity).mockResolvedValue(ADMIN as any);
    vi.mocked(getViewerLocations).mockResolvedValue(null);
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
  });

  it("★ refuses a viewer without the pos section", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect((await getShiftHistory()).error).toMatch(/not authorized/i);
    expect((await getShiftReport("sh-1")).error).toMatch(/not authorized/i);
  });

  it("★★ an EMPTY location scope shows NOTHING, never everything", async () => {
    // "Assigned to nothing that still exists" is a real state — their shop was
    // deleted. Widening it to unrestricted would promote a bound admin to
    // seeing the whole business (lib/locations/scope.ts).
    vi.mocked(getViewerLocations).mockResolvedValue([]);
    const res = await getShiftHistory();
    expect(res.shifts).toEqual([]);
    expect(res.error).toBeUndefined();
    // Nothing was even asked of the database.
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("★★ a shift from another store is NOT readable by id", async () => {
    // loadReport takes a shift id and applies no store predicate of its own —
    // safe at a till, where the operator's location bounds it. Here the id
    // comes from the client, so ownership is proved BEFORE the report is built.
    //
    // ⚠ THE SEED IS THE WHOLE TEST. The ownership query returns EMPTY while a
    // perfectly good shift sits behind it, so dropping the guard produces a
    // REPORT rather than "not found". Seeding only `[[]]` made this pass either
    // way — mutation testing caught that, which is exactly what it is for.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [], // ownership: this shift is NOT the viewer's
        ...reportSeed(), // ...but loadReport would happily build it
      ],
    });
    const res = await getShiftReport("someone-elses-shift");
    expect(res.error).toMatch(/not found/i);
    expect(res.report).toBeUndefined();
  });

  it("★ an unrestricted viewer is scoped to their STORE at minimum", async () => {
    vi.mocked(getViewerLocations).mockResolvedValue(null);
    await getShiftHistory();
    // One query ran, and it was not unbounded.
    expect(dbHolder.current.calls.select.length).toBeGreaterThan(0);
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("refuses an empty shift id before touching the database", async () => {
    expect((await getShiftReport("")).error).toMatch(/invalid shift/i);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });
});
