/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbHolder = vi.hoisted(() => ({
  rows: [] as any[],
  throws: false,
  queries: [] as string[],
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) =>
    fn({
      execute: async (q: any) => {
        if (dbHolder.throws) throw new Error("connection reset");
        dbHolder.queries.push(
          Array.isArray(q?.queryChunks)
            ? q.queryChunks
                .map((c: any) => c?.value ?? "")
                .flat()
                .join("")
            : String(q),
        );
        return { rows: dbHolder.rows };
      },
    }),
  ),
}));

import {
  commitHold,
  holdStock,
  releaseHold,
  sweepExpiredHolds,
} from "./reservations";

const REQ = {
  storeId: "store-1",
  locationId: "loc-1",
  productId: "p1",
  variantId: null,
  quantity: 2,
  owner: "pickup" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.rows = [];
  dbHolder.throws = false;
  dbHolder.queries = [];
});

describe("holdStock", () => {
  it("returns the reservation id", async () => {
    dbHolder.rows = [{ id: "res-1" }];
    expect(await holdStock(REQ)).toBe("res-1");
    expect(dbHolder.queries[0]).toContain("hold_stock_at");
  });

  // Null is an ANSWER, not an error: the location hasn't got that many free.
  // The caller decides whether to try elsewhere or tell the shopper.
  it("returns null when the location can't cover it", async () => {
    dbHolder.rows = [{ id: null }];
    expect(await holdStock(REQ)).toBeNull();
  });

  it("rejects a zero, negative or fractional quantity without querying", async () => {
    for (const quantity of [0, -3, 1.5]) {
      expect(await holdStock({ ...REQ, quantity })).toBeNull();
    }
    expect(dbHolder.queries).toHaveLength(0);
  });

  // A hold is an optimisation over not holding; a DB blip must not throw into
  // a checkout or a pickup flow.
  it("returns null rather than throwing when the RPC fails", async () => {
    dbHolder.throws = true;
    expect(await holdStock(REQ)).toBeNull();
  });
});

describe("commitHold", () => {
  it("reports success", async () => {
    dbHolder.rows = [{ ok: true }];
    expect(await commitHold("res-1", "order-1")).toBe(true);
    expect(dbHolder.queries[0]).toContain("commit_stock_hold");
  });

  // The RPC claims held→committed conditionally, so a retried webhook moves
  // stock exactly once and the second call reports false.
  it("reports false for an already-settled hold", async () => {
    dbHolder.rows = [{ ok: false }];
    expect(await commitHold("res-1")).toBe(false);
  });

  it("survives a failure", async () => {
    dbHolder.throws = true;
    expect(await commitHold("res-1")).toBe(false);
  });
});

describe("releaseHold", () => {
  it("gives the units back", async () => {
    dbHolder.rows = [{ ok: true }];
    expect(await releaseHold("res-1")).toBe(true);
    expect(dbHolder.queries[0]).toContain("release_stock_hold");
  });

  it("reports false for an already-settled hold", async () => {
    dbHolder.rows = [{ ok: false }];
    expect(await releaseHold("res-1")).toBe(false);
  });
});

describe("sweepExpiredHolds", () => {
  it("reports how many it freed", async () => {
    dbHolder.rows = [{ n: 4 }];
    expect(await sweepExpiredHolds()).toBe(4);
    expect(dbHolder.queries[0]).toContain("sweep_expired_holds");
  });

  it("reads a non-numeric result as zero", async () => {
    dbHolder.rows = [{}];
    expect(await sweepExpiredHolds()).toBe(0);
  });

  // It runs inside a cron that also does payment reconciliation — a sweep
  // failure must not take that down.
  it("returns zero rather than throwing", async () => {
    dbHolder.throws = true;
    expect(await sweepExpiredHolds()).toBe(0);
  });
});
