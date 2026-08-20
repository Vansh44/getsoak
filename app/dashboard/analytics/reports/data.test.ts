/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  wheres: [] as unknown[],
  resultSets: [] as unknown[][],
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (reader: (db: unknown) => unknown) => {
    const db = {
      select: vi.fn(() => {
        const rows = captured.resultSets.shift() ?? [];
        const chain: any = {};
        for (const method of [
          "from",
          "leftJoin",
          "innerJoin",
          "orderBy",
          "limit",
        ]) {
          chain[method] = vi.fn(() => chain);
        }
        chain.where = vi.fn((where: unknown) => {
          captured.wheres.push(where);
          return chain;
        });
        chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
        return chain;
      }),
    };
    return reader(db);
  }),
}));

import { getTotalSalesReport } from "./data";
import { parseAnalyticsRange } from "@/lib/analytics/range";

function boundValues(node: any, depth = 0): unknown[] {
  if (depth > 12 || node === null || node === undefined) return [];
  if (typeof node !== "object") return [node];
  if (Array.isArray(node)) {
    return node.flatMap((value) => boundValues(value, depth + 1));
  }
  if (node.queryChunks) return boundValues(node.queryChunks, depth + 1);
  if ("value" in node) return boundValues(node.value, depth + 1);
  return [];
}

beforeEach(() => {
  captured.wheres = [];
  captured.resultSets = [];
});

describe("total sales report", () => {
  it("keeps both tenant and location scope and represents refunds negatively", async () => {
    captured.resultSets = [
      [
        {
          id: "sale-1",
          occurredAt: "2026-08-20T10:00:00.000Z",
          orderRef: "SM-101",
          channel: "online",
          location: "Online / unassigned",
          amount: 120,
        },
      ],
      [
        {
          id: "refund-1",
          occurredAt: "2026-08-20T11:00:00.000Z",
          orderRef: "SM-100",
          channel: "pos",
          location: "Main shop",
          amount: 20,
        },
      ],
    ];
    const range = parseAnalyticsRange(
      { range: "7d", compare: "none" },
      "Asia/Kolkata",
      new Date("2026-08-20T12:00:00.000Z"),
    );

    const rows = await getTotalSalesReport(
      "store-tenant",
      {
        locationIds: ["loc-allowed"],
        includeUnassigned: true,
        selectedId: null,
      },
      range,
      250,
    );

    expect(rows[0]).toMatchObject({
      event: "Refund",
      channel: "Point of sale",
      amount: -20,
    });
    expect(rows[1]).toMatchObject({
      event: "Sale",
      channel: "Online store",
      amount: 120,
    });
    expect(captured.wheres).toHaveLength(2);
    for (const where of captured.wheres) {
      const values = boundValues(where);
      expect(values).toContain("store-tenant");
      expect(values).toContain("loc-allowed");
    }
  });
});
