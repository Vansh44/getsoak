/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
afterEach(() => vi.useRealTimers());
import { PgDialect } from "drizzle-orm/pg-core";
import {
  minkWatchResponses,
  minkWorkflowRuns,
  minkWorkflowSteps,
} from "@/drizzle/schema";
const h = vi.hoisted(() => ({
  reads: [] as any[][],
  writes: [] as any[],
  predicates: [] as any[],
  enabled: true,
  scope: vi.fn(),
}));
function chain(rows: any[], table?: any): any {
  return new Proxy(
    {},
    {
      get(_, key) {
        if (key === "then") return (resolve: any) => resolve(rows);
        if (key === "values")
          return (value: any) => {
            h.writes.push({ table, value });
            return chain(rows, table);
          };
        if (key === "where")
          return (value: any) => {
            h.predicates.push(new PgDialect().sqlToQuery(value));
            return chain(rows, table);
          };
        return () => chain(rows, table);
      },
    },
  );
}
const db = {
  select: () => chain(h.reads.shift() ?? []),
  insert: (table: any) => chain([], table),
};
vi.mock("@/lib/db/client", () => ({ withService: (fn: any) => fn(db) }));
vi.mock("./workflows", () => ({ revalidateWorkflowAuthority: h.scope }));
vi.mock("./config", () => ({
  getMinkConfig: () => ({ enabled: h.enabled, betaRequireInvite: false }),
}));
import {
  listProactiveResponses,
  decideProactiveResponse,
} from "./proactive-responses";
const id = "11111111-1111-4111-8111-111111111111",
  sourceId = "22222222-2222-4222-8222-222222222222";
const actor = { storeId: "echos", adminId: "owner" } as any;
const w = {
  id,
  storeId: "echos",
  adminId: "owner",
  version: 1,
  status: "active",
  kind: "inventory",
  processedRunId: sourceId,
  inputJson: {
    locationIds: ["Delhi"],
    locationLabel: "Delhi",
    period: "daily",
    timeZone: "Asia/Kolkata",
    includeUnassigned: false,
  },
};
const source = {
  id: sourceId,
  completedAt: "2026-09-06T10:00:00Z",
  resultJson: {
    dataAsOf: "2026-09-06T09:59:00Z",
    locationLabel: "Delhi",
    timeZone: "Asia/Kolkata",
    rangeLabel: "Yesterday",
    signals: [
      {
        key: "inventory",
        status: "attention",
        evidence: "2 empty shelves in Delhi",
      },
    ],
  },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
  h.reads = [];
  h.writes = [];
  h.predicates = [];
  h.enabled = true;
  h.scope.mockReset().mockResolvedValue({ locationIds: ["Delhi"] });
});
async function plan() {
  h.reads = [[w], [], [source], []];
  return (await listProactiveResponses(actor, id)).plans[0];
}
async function request() {
  const p = await plan();
  h.reads = [[w], [], [source], [], []];
  return {
    action: "approve",
    watchId: id,
    sourceRunId: sourceId,
    signal: "inventory",
    planHash: p.planHash,
    confirmed: true,
  };
}
describe("scoped one-time response consent", () => {
  it("reads owner-only evidence without inserting anything", async () => {
    const p = await plan();
    expect(p.rank).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.predicates[0].params).toEqual([id, "echos", "owner"]);
  });
  it("atomically writes the approved response and a two-step bounded workflow", async () => {
    await decideProactiveResponse(actor, await request());
    const run = h.writes.find((w) => w.table === minkWorkflowRuns).value;
    expect(run).toMatchObject({
      storeId: "echos",
      adminId: "owner",
      watchId: id,
      template: "watch_response_review",
      totalSteps: 2,
      inputJson: {
        locationIds: ["Delhi"],
        includeUnassigned: false,
        signal: "inventory",
      },
    });
    expect(
      h.writes.find((w) => w.table === minkWorkflowSteps).value,
    ).toHaveLength(2);
    expect(
      h.writes.find((w) => w.table === minkWatchResponses).value,
    ).toMatchObject({
      status: "approved",
      workflowId: run.id,
      sourceRunId: sourceId,
      watchVersion: 1,
    });
  });
  it.each([false, "true", undefined])(
    "rejects missing explicit consent %s before writes",
    async (confirmed) => {
      const r = await request();
      await expect(
        decideProactiveResponse(actor, { ...r, confirmed }),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.writes).toEqual([]);
    },
  );
  it("rejects invented scope/operation fields", async () => {
    await expect(
      decideProactiveResponse(actor, {
        ...(await request()),
        storeId: "victim",
        quantity: 999,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.writes).toEqual([]);
  });
  it("cannot access another owner's watch", async () => {
    h.reads = [[]];
    await expect(listProactiveResponses(actor, id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("invalidates a plan if the watch version or scope changed", async () => {
    const r = await request();
    h.reads = [[{ ...w, version: 2 }], [], [source], [], []];
    await expect(decideProactiveResponse(actor, r)).rejects.toMatchObject({
      status: 409,
    });
    expect(h.writes).toEqual([]);
  });
  it("rejects a replaced source snapshot", async () => {
    const r = await request();
    h.reads = [
      [w],
      [],
      [{ ...source, id: "33333333-3333-4333-8333-333333333333" }],
      [],
      [],
    ];
    await expect(decideProactiveResponse(actor, r)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("expires consent after 24 hours", async () => {
    const r = await request();
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    await expect(decideProactiveResponse(actor, r)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("refuses a paused watch", async () => {
    const r = await request();
    h.reads = [[{ ...w, status: "paused" }], []];
    await expect(decideProactiveResponse(actor, r)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("refuses overlapping work", async () => {
    const r = await request();
    h.reads = [[w], [], [source], [], [{ id: "busy" }]];
    await expect(decideProactiveResponse(actor, r)).rejects.toMatchObject({
      status: 409,
    });
    expect(h.writes).toEqual([]);
  });
  it("returns the original workflow on an exact retry without new writes", async () => {
    const r = await request();
    h.reads = [
      [w],
      [{ planHash: r.planHash, status: "approved", workflowId: "existing" }],
    ];
    expect(await decideProactiveResponse(actor, r)).toEqual({
      status: "approved",
      workflowId: "existing",
    });
    expect(h.writes).toEqual([]);
  });
  it("dismissal records a decision without starting a workflow", async () => {
    const r = await request();
    await decideProactiveResponse(actor, {
      ...r,
      action: "dismiss",
      confirmed: false,
    });
    expect(h.writes.some((w) => w.table === minkWorkflowRuns)).toBe(false);
    expect(
      h.writes.find((w) => w.table === minkWatchResponses).value.status,
    ).toBe("dismissed");
  });
  it("cannot turn a dismissal into consent by retrying", async () => {
    const r = await request();
    h.reads = [
      [w],
      [{ planHash: r.planHash, status: "dismissed", workflowId: null }],
    ];
    await expect(decideProactiveResponse(actor, r)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("fails closed when permission narrows or the kill switch is off", async () => {
    const r = await request();
    h.scope.mockResolvedValue(null);
    await expect(decideProactiveResponse(actor, r)).rejects.toMatchObject({
      status: 403,
    });
    h.enabled = false;
    h.reads = [[w]];
    await expect(listProactiveResponses(actor, id)).rejects.toMatchObject({
      status: 403,
    });
    expect(h.writes).toEqual([]);
  });
});
