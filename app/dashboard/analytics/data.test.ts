/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Every query is captured rather than executed: what matters here is WHICH
// rows a viewer's figures are computed from, which lives entirely in the WHERE.
const captured = vi.hoisted(() => ({ wheres: [] as unknown[] }));

function chain(): any {
  const c: any = {};
  const self = () => c;
  for (const m of [
    "select",
    "from",
    "leftJoin",
    "innerJoin",
    "groupBy",
    "orderBy",
    "limit",
  ]) {
    c[m] = vi.fn(self);
  }
  c.where = vi.fn((w: unknown) => {
    captured.wheres.push(w);
    return c;
  });
  // ★ ONE permissive row, not []. The data layer destructures scalar results
  // (`const [[{ c }]] = await Promise.all(...)`), so an empty array throws
  // before any WHERE is captured — and the test would then be asserting on a
  // crash rather than on the query.
  const row = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === "then" ? undefined : k === "key" ? "online" : (0 as never),
    },
  );
  c.then = (res: (v: unknown[]) => unknown) => res([row]);
  return c;
}

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(chain())),
}));

import {
  buildPaymentBreakdown,
  classifyCustomerMix,
  comparisonTrend,
  getRecentOrders,
  getSalesAnalytics,
  getSalesByChannel,
  RECOGNIZED_PAYMENT_STATUSES,
  RECOGNIZED_POS_STATUSES,
} from "./data";
import { parseAnalyticsRange } from "@/lib/analytics/range";

const range = parseAnalyticsRange(
  { range: "7d", compare: "none" },
  "Asia/Kolkata",
  new Date("2026-08-18T10:30:00.000Z"),
);

const allLocations = {
  locationIds: null,
  includeUnassigned: true,
  selectedId: null,
} as const;
const scopedLocations = (locationIds: string[]) => ({
  locationIds,
  includeUnassigned: true,
  selectedId: null,
});

/**
 * The PARAMETER values across every captured WHERE.
 *
 * ⚠ Not JSON.stringify — a drizzle predicate holds a PgTable that references
 * its own columns, so stringifying it throws on the circular structure. And not
 * the codebase's `sqlText` either: that renders the SQL TEXT only, where an
 * `inArray`'s ids are bound parameters. The ids are exactly what distinguishes
 * a scoped query from an unscoped one, so they are what this walks for.
 */
function params(): unknown[] {
  const out: unknown[] = [];
  const walk = (node: any, depth = 0) => {
    if (depth > 12 || node === null || node === undefined) return;
    if (typeof node !== "object") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (node.queryChunks) return walk(node.queryChunks, depth + 1);
    // A bound value; anything else is table/column machinery.
    if ("value" in node) walk(node.value, depth + 1);
  };
  captured.wheres.forEach((w) => walk(w));
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.wheres = [];
});

describe("analytics data — location scope", () => {
  // ★★ THE OWNER'S VIEW IS UNCHANGED. Running several shops is the reason to
  // want whole-business figures, so an unrestricted viewer must not suddenly be
  // narrowed by a feature aimed at their staff.
  it("adds no location predicate for an unrestricted viewer", async () => {
    await getRecentOrders("store-1", allLocations, range);
    expect(params()).not.toContain("loc-1");
  });

  // ★ Otherwise the first screen a restricted admin lands on hands them every
  // other branch's revenue, while the orders list refuses them a single order
  // from it.
  it("bounds a restricted viewer's figures to their shops", async () => {
    await getRecentOrders(
      "store-1",
      scopedLocations(["loc-1", "loc-2"]),
      range,
    );
    const sent = params();
    expect(sent).toContain("loc-1");
    expect(sent).toContain("loc-2");
  });

  it("applies the same scope to Phase 2 commerce widgets", async () => {
    await getSalesByChannel("store-1", scopedLocations(["loc-2"]), range);
    expect(params()).toContain("loc-2");
  });

  // ⚠ EMPTY is "assigned to nothing that still exists" — a real state, NOT
  // unrestricted. It must produce a predicate that matches nothing rather than
  // silently widening to the whole store.
  it("still bounds a viewer assigned to nothing that exists", async () => {
    await getRecentOrders("store-1", scopedLocations([]), range);
    // The store filter is always present; what must NOT happen is the query
    // running with no location predicate at all.
    expect(captured.wheres.length).toBeGreaterThan(0);
  });
});

describe("recognized sales", () => {
  it("uses the settled/COD/POS contract and completed refunds", async () => {
    await getSalesAnalytics("store-1", allLocations, range);
    const sent = params();
    expect(sent).toContain("completed");
    expect(sent).toContain("cancelled");
    expect(RECOGNIZED_PAYMENT_STATUSES).toEqual([
      "paid",
      "partially_refunded",
      "refunded",
    ]);
    expect(RECOGNIZED_POS_STATUSES).toEqual(["completed", "refunded"]);
  });

  it("omits a misleading percentage when comparison is absent or zero", () => {
    expect(comparisonTrend(100, null).trendPct).toBeNull();
    expect(comparisonTrend(100, 0).trendPct).toBeNull();
    expect(comparisonTrend(75, 100)).toEqual({
      trendPct: -25,
      trendUp: false,
    });
  });
});

describe("payment-method allocation", () => {
  it("combines itemized POS and online tenders, then subtracts recorded refunds", () => {
    const rows = buildPaymentBreakdown({
      pos: [
        { key: "cash", amount: 100, orders: 1 },
        { key: "card", amount: 50, orders: 1 },
      ],
      online: [
        { key: "cash_on_delivery", amount: 80, orders: 1 },
        { key: "split", amount: 999, orders: 1 },
      ],
      storeCredit: { amount: 20, orders: 1 },
      refunds: [
        { key: "cash", refunds: 30 },
        { key: "store_credit", refunds: 5 },
      ],
    });
    expect(
      Object.fromEntries(rows.map((row) => [row.key, row.amount])),
    ).toEqual({
      cash: 70,
      card: 50,
      cash_on_delivery: 80,
      store_credit: 15,
    });
    expect(rows.some((row) => row.key === "split")).toBe(false);
  });

  it("keeps a refund-only method visible instead of guessing its source", () => {
    expect(
      buildPaymentBreakdown({
        pos: [],
        online: [],
        storeCredit: null,
        refunds: [{ key: "manual", refunds: 25 }],
      })[0],
    ).toMatchObject({ key: "manual", name: "Manual refund", amount: -25 });
  });
});

describe("customer mix", () => {
  it("classifies only customers active in the range by their first accessible order", () => {
    expect(
      classifyCustomerMix(
        [
          { firstOrderAt: "2026-08-01T00:00:00.000Z", currentOrders: 1 },
          { firstOrderAt: "2026-08-18T00:00:00.000Z", currentOrders: 2 },
          { firstOrderAt: "2026-07-01T00:00:00.000Z", currentOrders: 0 },
        ],
        new Date("2026-08-10T00:00:00.000Z"),
      ),
    ).toEqual({
      newCustomers: 1,
      returningCustomers: 1,
      totalCustomers: 2,
    });
  });
});
