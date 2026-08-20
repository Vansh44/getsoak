/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (reader: (db: unknown) => unknown) => {
    const db = {
      select: vi.fn(() => {
        const chain: any = {};
        for (const method of ["from", "groupBy", "orderBy", "limit"]) {
          chain[method] = vi.fn(() => chain);
        }
        chain.where = vi.fn((where: unknown) => {
          captured.wheres.push(where);
          return chain;
        });
        chain.then = (resolve: (rows: unknown[]) => unknown) =>
          resolve(captured.rows.shift() ?? []);
        return chain;
      }),
    };
    return reader(db);
  }),
}));

import {
  deriveSearchState,
  getSearchAnalytics,
  getSearchRankingReport,
  searchDateWindow,
  searchMetricStat,
  searchRangeLabel,
  toSearchRanking,
} from "./search-data";
import { parseAnalyticsRange } from "@/lib/analytics/range";

function boundValues(node: any, depth = 0): unknown[] {
  if (depth > 12 || node === null || node === undefined) return [];
  if (typeof node !== "object") return [node];
  if (Array.isArray(node))
    return node.flatMap((value) => boundValues(value, depth + 1));
  if (node.queryChunks) return boundValues(node.queryChunks, depth + 1);
  if ("value" in node) return boundValues(node.value, depth + 1);
  return [];
}

beforeEach(() => {
  captured.rows = [];
  captured.wheres = [];
});

describe("Search analytics presentation contract", () => {
  it("maps merchant instants to inclusive Pacific Search Console dates", () => {
    const window = searchDateWindow({
      from: new Date("2026-08-18T18:00:00.000Z"),
      to: new Date("2026-08-20T02:00:00.000Z"),
    });
    expect(window).toEqual({ from: "2026-08-18", to: "2026-08-19" });
    expect(searchRangeLabel(window)).toBe("18 Aug – 19 Aug");
  });

  it("never turns a missing complete day into a zero-visibility result", () => {
    expect(
      deriveSearchState({
        launched: true,
        completeDays: 0,
        impressions: 0,
        error: false,
      }),
    ).toBe("collecting");
    expect(
      deriveSearchState({
        launched: true,
        completeDays: 1,
        impressions: 0,
        error: false,
      }),
    ).toBe("no_visibility");
  });

  it("prioritizes launch and actionable source errors", () => {
    expect(
      deriveSearchState({
        launched: false,
        completeDays: 0,
        impressions: 0,
        error: true,
      }),
    ).toBe("not_launched");
    expect(
      deriveSearchState({
        launched: true,
        completeDays: 0,
        impressions: 0,
        error: true,
      }),
    ).toBe("error");
  });

  it("treats a lower average position as an improvement", () => {
    expect(searchMetricStat(8, 10, [10, 8], true)).toMatchObject({
      trendPct: -20,
      direction: "down",
      improved: true,
    });
  });

  it("derives CTR and impression-weighted position from aggregates", () => {
    expect(
      toSearchRanking([
        {
          key: "linen shirt",
          clicks: 5,
          impressions: 20,
          positionSum: 150,
        },
      ]),
    ).toEqual([
      {
        key: "linen shirt",
        clicks: 5,
        impressions: 20,
        ctr: 25,
        position: 7.5,
      },
    ]);
  });

  it("binds the acting store to every service-role read", async () => {
    captured.rows = [[{ settings: { launched: true } }], [], [], [], []];
    const range = parseAnalyticsRange(
      { range: "7d", compare: "none" },
      "Asia/Kolkata",
      new Date("2026-08-19T08:00:00.000Z"),
    );

    await getSearchAnalytics("store-tenant", range);

    expect(captured.wheres).toHaveLength(5);
    for (const where of captured.wheres) {
      expect(boundValues(where)).toContain("store-tenant");
    }
  });

  it("keeps detailed query reports tenant-bound", async () => {
    captured.rows = [
      [{ key: "linen", clicks: 2, impressions: 10, positionSum: 50 }],
    ];
    const range = parseAnalyticsRange(
      { range: "7d", compare: "none" },
      "Asia/Kolkata",
      new Date("2026-08-19T08:00:00.000Z"),
    );

    await expect(
      getSearchRankingReport("store-tenant", range, "query", 250),
    ).resolves.toEqual([
      {
        key: "linen",
        clicks: 2,
        impressions: 10,
        ctr: 20,
        position: 5,
      },
    ]);
    expect(boundValues(captured.wheres[0])).toContain("store-tenant");
  });
});
