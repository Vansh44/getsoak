/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ★★ THE REGRESSION THIS FILE EXISTS FOR. `parseClaimedWorkflow` threw
 * `invalid_claimed_workflow_row` when the claim CTE matched nothing — which is
 * the STEADY STATE, since most heartbeats find an empty queue. `claimWorkflow`
 * is awaited outside the worker's try/catch (`if (!run) break` is written for
 * exactly that case) and the cron route has no catch of its own, so the throw
 * escaped all the way out: the minute job answered 500 forever, and because the
 * loop only ever exits by the queue draining, the notification delivery below
 * it never ran. A workflow completed and nobody was ever told.
 *
 * `route.test.ts` mocks `runMinkWorkflowWorker` wholesale, so nothing anywhere
 * exercised the worker itself. That is why the whole suite stayed green.
 */

/** What each `withService` callback should see. Set per test. */
const state = vi.hoisted(() => ({
  selectRows: [] as any[][],
  executeRows: [] as any[][],
  selectCalls: 0,
  executeCalls: 0,
  setCalls: [] as any[],
}));

/**
 * A chainable stand-in: every builder method returns the chain, and awaiting it
 * yields the next queued row set. Enough for the three reads the worker makes
 * on an idle tick, and deliberately not more — this pins the empty-queue path,
 * not the SQL.
 */
function chain(rows: any[]) {
  const c: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: any) => resolve(rows);
        }
        // `.set({...})` is the only builder call whose ARGUMENT matters here:
        // it is how a re-queue states what it leaves behind on the run row.
        if (prop === "set") {
          return (payload: any) => {
            state.setCalls.push(payload);
            return c;
          };
        }
        return () => c;
      },
    },
  );
  return c;
}

const db = {
  select: () => {
    const rows = state.selectRows[state.selectCalls] ?? [];
    state.selectCalls += 1;
    return chain(rows);
  },
  execute: () => {
    const rows = state.executeRows[state.executeCalls] ?? [];
    state.executeCalls += 1;
    return Promise.resolve({ rows });
  },
  update: () => chain([]),
  insert: () => chain([]),
};

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(db))),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: false })),
}));
vi.mock("./config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: false })),
}));
vi.mock("@/lib/notifications/record", () => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  getMinkWorkflow,
  resumeMinkWorkflow,
  runMinkWorkflowWorker,
} from "./workflows";

describe("the Mink workflow worker on an idle tick", () => {
  beforeEach(() => {
    state.selectRows = [];
    state.executeRows = [];
    state.selectCalls = 0;
    state.executeCalls = 0;
    state.setCalls = [];
  });

  it("★★ returns quietly when the queue is empty, instead of throwing", async () => {
    // Every read comes back empty: nothing to reap, nothing to claim, nothing
    // to notify — the shape of almost every minute of every day.
    await expect(runMinkWorkflowWorker()).resolves.toMatchObject({
      claims: 0,
      workflowsCompleted: 0,
      workflowsFailed: 0,
    });
  });

  it("★ still reaches notification delivery after the queue drains", async () => {
    // The bug's real cost was not the 500 — it was that the throw jumped over
    // `deliverPendingWorkflowNotifications`, which sits AFTER the claim loop.
    // A completed workflow therefore never produced its in-dashboard notice.
    await runMinkWorkflowWorker();
    // reap + claim(execute) + deliver: the delivery read is the last one, so
    // reaching a second SELECT is the evidence the loop exited normally.
    expect(state.executeCalls).toBeGreaterThan(0);
    expect(state.selectCalls).toBeGreaterThanOrEqual(2);
  });

  it("★ a genuinely malformed claimed row is still loud", async () => {
    // Nothing-to-claim and a-row-we-cannot-trust must stay different answers.
    // Degrading both to `null` would let a corrupt row be silently skipped.
    state.executeRows = [[{ id: 42, status: "running" }]];
    await expect(runMinkWorkflowWorker()).rejects.toThrow(
      "invalid_claimed_workflow_row",
    );
  });
});

// ★★ THE RETRY BUDGET IS PER STEP, OR A RUN THAT IS SUCCEEDING CAN STRAND.
//
// `claimWorkflow` increments `attempt_count` on EVERY claim and its candidate
// predicate is `attempt_count < max_attempts`, so a run-level budget is spent by
// ordinary progress as much as by retries. A step that SUCCEEDS on the last
// permitted attempt then re-queued the run AT the ceiling: never claimable
// again, and never failed either, because `failExpiredExhaustedWorkflows` only
// looks at `running`. No result, no notification, no error — the dashboard card
// polls `queued` at 3s forever.
//
// ★ THE SCHEMA ALREADY IMPLIED THE FIX. `max_attempts BETWEEN total_steps AND
// 20` permits a budget EQUAL to the step count, and at that lower bound a
// perfectly healthy run spends every attempt just walking its steps — so a
// single retry would strand it. A budget that only works above its own legal
// minimum is a per-step budget being accounted per run.
/** The minimum a durable run's captured authority must satisfy to be read back. */
const WEEKLY_INPUT = {
  timeZone: "Asia/Kolkata",
  currency: "INR",
  locationIds: [],
  restrictedLocationScope: false,
  includeUnassigned: true,
  locationLabel: "All locations",
  requesterEmail: null,
  requestedAt: "2026-09-01T00:00:00.000Z",
};

describe("★★ the workflow retry budget is per step", () => {
  beforeEach(() => {
    state.selectRows = [];
    state.executeRows = [];
    state.selectCalls = 0;
    state.executeCalls = 0;
    state.setCalls = [];
  });

  /** The payload of the update that put the run back on the queue. */
  /**
   * The payloads that put the RUN back on the queue.
   *
   * ★ `runAfter` is what tells them apart from the STEP row's own re-queue:
   * both set `status: "queued"`, and only the run carries a next-run time.
   */
  const runRequeues = () =>
    state.setCalls.filter(
      (p: any) => p?.status === "queued" && "runAfter" in p,
    );
  const requeue = () => runRequeues()[0];

  it("★★ resuming an approved run clears the attempts it had spent", async () => {
    // A run parked at `waiting_approval` may already sit at the ceiling — the
    // steps before the checkpoint spent the budget. Re-queueing it there
    // accepts the human's approval and then never acts on it.
    state.selectRows = [
      [
        {
          id: "wf-1",
          storeId: "store-1",
          adminId: "admin-1",
          template: "weekly_trading_report",
          status: "waiting_approval",
          inputJson: WEEKLY_INPUT,
          currentStep: 1,
          totalSteps: 3,
          attemptCount: 6,
          maxAttempts: 6,
        },
      ],
      [],
    ];

    await resumeMinkWorkflow(
      {
        storeId: "store-1",
        adminId: "admin-1",
        permissions: { analytics: ["view"] },
        draftingEnabled: true,
      } as any,
      "wf-1",
    ).catch(() => {
      // The view it builds afterwards reads rows this mock does not stock; the
      // re-queue has already been issued by then, which is what is asserted.
    });

    expect(requeue()).toBeDefined();
    // ★ `attemptCount` must be RESET, not merely left alone. Left at 6 of 6 the
    // claim predicate `attempt_count < max_attempts` can never match again.
    expect(requeue()?.attemptCount).toBe(0);
  });

  it("★ a re-queue never leaves the run at its own ceiling", async () => {
    // The invariant behind both call sites, stated once: whatever puts a run
    // back on the queue must leave it claimable. A future re-queue path that
    // forgets this reproduces the strand exactly.
    state.selectRows = [
      [
        {
          id: "wf-1",
          storeId: "store-1",
          adminId: "admin-1",
          template: "weekly_trading_report",
          status: "waiting_approval",
          inputJson: WEEKLY_INPUT,
          currentStep: 1,
          totalSteps: 3,
          attemptCount: 6,
          maxAttempts: 6,
        },
      ],
      [],
    ];
    await resumeMinkWorkflow(
      {
        storeId: "store-1",
        adminId: "admin-1",
        permissions: { analytics: ["view"] },
        draftingEnabled: true,
      } as any,
      "wf-1",
    ).catch(() => {});

    expect(runRequeues()).not.toHaveLength(0);
    for (const payload of runRequeues()) {
      expect(payload.attemptCount).toBeLessThan(6);
    }
  });
});

// ★★ A FINISHED REPORT IS NOT A CAPABILITY TOKEN EITHER.
//
// `revalidateWorkflowAuthority` narrows a run's captured locations to what the
// actor may still see before every BACKGROUND step. A run that already
// completed has its figures sitting in `result_json`, and the READ returned
// them on nothing more than owner + permission — so an unrestricted admin could
// queue a store-wide trading report, be bound to one location by the owner,
// reopen the Mink thread and read store-wide net sales, orders and top products
// that `/dashboard/analytics` and the orders list would both now refuse them
// (CODEBASE §23).
describe("★★ reading a completed workflow re-checks the captured scope", () => {
  beforeEach(() => {
    state.selectRows = [];
    state.executeRows = [];
    state.selectCalls = 0;
    state.executeCalls = 0;
    state.setCalls = [];
  });

  const actor = (locationIds: string[] | null, isSuperadmin = false) =>
    ({
      storeId: "store-1",
      adminId: "admin-1",
      permissions: { analytics: ["view"] },
      draftingEnabled: true,
      isSuperadmin,
      locationIds,
    }) as any;

  function seedRun(input: Record<string, unknown>) {
    // Re-seeding rewinds the queue: each call is a fresh read.
    state.selectCalls = 0;
    state.selectRows = [
      [
        {
          id: "wf-1",
          storeId: "store-1",
          adminId: "admin-1",
          template: "weekly_trading_report",
          status: "completed",
          inputJson: { ...WEEKLY_INPUT, ...input },
          currentStep: 3,
          totalSteps: 3,
          attemptCount: 1,
          maxAttempts: 6,
          resultJson: { netSales: 999999 },
        },
      ],
      [],
    ];
  }

  it("★★ refuses a store-wide result to an actor now bound to one location", async () => {
    // The exact scenario: queued while unrestricted, read after narrowing.
    seedRun({ locationIds: [], includeUnassigned: true });
    await expect(getMinkWorkflow(actor(["loc-a"]), "wf-1")).rejects.toThrow(
      /no longer have access/i,
    );
  });

  it("★ refuses a result that counted unassigned and online orders", async () => {
    // Online orders carry no location, so a location-bound admin may not see
    // them at all — a captured subset is not enough on its own.
    seedRun({
      locationIds: ["11111111-1111-4111-8111-111111111111"],
      includeUnassigned: true,
    });
    await expect(
      getMinkWorkflow(actor(["11111111-1111-4111-8111-111111111111"]), "wf-1"),
    ).rejects.toThrow(/no longer have access/i);
  });

  it("★ allows a result entirely inside what the actor still sees", async () => {
    seedRun({
      locationIds: ["11111111-1111-4111-8111-111111111111"],
      includeUnassigned: false,
    });
    await expect(
      getMinkWorkflow(
        actor([
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ]),
        "wf-1",
        false,
      ),
    ).resolves.toBeDefined();
  });

  it("★ an UNRESTRICTED actor is unaffected — null and [] both mean unrestricted", async () => {
    // "No rows = unrestricted" is what `admin_locations` has always meant
    // (§23), so neither shape may start refusing results.
    seedRun({ locationIds: [], includeUnassigned: true });
    await expect(
      getMinkWorkflow(actor(null), "wf-1", false),
    ).resolves.toBeDefined();
    seedRun({ locationIds: [], includeUnassigned: true });
    await expect(
      getMinkWorkflow(actor([]), "wf-1", false),
    ).resolves.toBeDefined();
  });

  it("★ a superadmin is never location-scoped", async () => {
    seedRun({ locationIds: [], includeUnassigned: true });
    await expect(
      getMinkWorkflow(actor(["loc-a"], true), "wf-1", false),
    ).resolves.toBeDefined();
  });
});
