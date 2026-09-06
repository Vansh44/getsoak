/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { minkWatches, minkWorkflowRuns } from "@/drizzle/schema";
const h = vi.hoisted(() => ({
  selects: [] as any[][],
  inserts: [] as any[][],
  writes: [] as any[],
  sql: [] as string[],
  scopes: vi.fn(),
  capture: vi.fn(),
  notify: vi.fn(),
  enabled: true,
}));
function chain(rows: any[], table?: any): any {
  const c: any = new Proxy(
    {},
    {
      get(_, key) {
        if (key === "then") return (resolve: any) => resolve(rows);
        if (key === "set" || key === "values")
          return (value: any) => {
            h.writes.push({ table, value });
            return c;
          };
        if (key === "where")
          return (value: any) => {
            h.sql.push(new PgDialect().sqlToQuery(value).sql);
            return c;
          };
        return () => c;
      },
    },
  );
  return c;
}
const db = {
  select: () => chain(h.selects.shift() ?? []),
  insert: (table: any) => chain(h.inserts.shift() ?? [], table),
  update: (table: any) => chain([], table),
  execute: (query: any) => {
    h.sql.push(new PgDialect().sqlToQuery(query).sql);
    return Promise.resolve({ rows: [] });
  },
};
vi.mock("@/lib/db/client", () => ({ withService: (fn: any) => fn(db) }));
vi.mock("./workflows", () => ({
  captureBusinessBriefInput: h.capture,
  revalidateWorkflowAuthority: h.scopes,
}));
vi.mock("./tools/location-scope", () => ({
  resolveMinkLocation: vi.fn(async () => ({
    availableLocations: [{ name: "Shop" }, { name: "Delhi" }],
  })),
}));
vi.mock("./config", () => ({
  getMinkConfig: () => ({ enabled: h.enabled, betaRequireInvite: false }),
}));
vi.mock("@/lib/notifications/record", () => ({ recordEvent: h.notify }));
import {
  changeMinkWatch,
  createMinkWatch,
  listMinkWatches,
  reconcileMinkWatches,
  scheduleMinkWatches,
} from "./watches";
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  period: "daily",
  timeZone: "Asia/Kolkata",
  locationIds: ["shop", "delhi"],
  locationLabel: "Shop and Delhi",
  defaultLowStockThreshold: 5,
};
const schedule = {
  frequency: "daily",
  time: "09:00",
  weekday: 1,
  quietStart: null,
  quietEnd: null,
};
const actor = {
  storeId: "echos",
  adminId: "admin",
  analyticsTimeZone: "Asia/Kolkata",
} as any;
const watch = {
  id,
  storeId: "echos",
  adminId: "admin",
  kind: "sales",
  status: "active",
  version: 1,
  inputJson: input,
  scheduleJson: schedule,
  nextRunAt: "2026-09-05T03:30:00Z",
  lastRunId: null,
  processedRunId: null,
  pendingRunId: null,
  fingerprint: null,
};
const result = {
  rulesVersion: "business-brief-v1",
  signals: [{ key: "sales", status: "attention" }],
  locations: [],
};
const now = new Date("2026-09-05T04:00:00Z");
beforeEach(() => {
  h.selects = [];
  h.inserts = [];
  h.writes = [];
  h.sql = [];
  h.enabled = true;
  h.scopes.mockReset().mockResolvedValue({ locationIds: ["shop", "delhi"] });
  h.capture.mockReset().mockResolvedValue(input);
  h.notify.mockReset().mockResolvedValue("event");
});
describe("owner-confirmed watches", () => {
  const request = {
    action: "create",
    confirmed: true,
    creationKey: id,
    kind: "sales",
    schedule,
  };
  it.each([
    { ...request, confirmed: false },
    { ...request, storeId: "other" },
    { ...request, kind: "shell" },
    { ...request, creationKey: "bad" },
  ])("rejects untrusted activation %j", async (raw) => {
    await expect(createMinkWatch(actor, raw)).rejects.toThrow();
    expect(h.writes).toHaveLength(0);
  });
  it("returns the existing watch on replay, without another insert", async () => {
    h.selects = [[watch]];
    await expect(createMinkWatch(actor, request)).resolves.toMatchObject({
      id,
    });
    expect(h.writes).toHaveLength(0);
    expect(h.sql.join(" ")).toContain("pg_advisory_xact_lock");
  });
  it("serializes and caps owner watches, including paused", async () => {
    h.selects = [[], Array(5).fill({ adminId: "admin" })];
    await expect(createMinkWatch(actor, request)).rejects.toThrow(
      "Limit reached",
    );
    expect(h.writes).toHaveLength(0);
  });
  it("caps the store across multiple owners", async () => {
    h.selects = [[], Array(20).fill({ adminId: "different" })];
    await expect(createMinkWatch(actor, request)).rejects.toThrow(
      "Limit reached",
    );
  });
  it("inserts a reviewed watch and audit entry with server identity", async () => {
    h.selects = [[], []];
    h.inserts = [[watch]];
    await createMinkWatch(actor, request);
    expect(h.writes[0].value).toMatchObject({
      storeId: "echos",
      adminId: "admin",
      inputJson: input,
    });
    expect(h.writes[1].value.event).toBe("created");
  });
  it("uses store and owner predicates on delete", async () => {
    h.selects = [[]];
    await expect(
      changeMinkWatch(actor, { action: "delete", id, version: 1 }),
    ).rejects.toThrow("not found");
    expect(h.sql[0]).toMatch(/store_id.*admin_id.*id/);
  });
  it("rejects stale versions without a write", async () => {
    h.selects = [[watch]];
    await expect(
      changeMinkWatch(actor, { action: "pause", id, version: 2 }),
    ).rejects.toThrow("changed");
    expect(h.writes).toHaveLength(0);
  });
  it("pause cancels in-flight work and clears the notification outbox", async () => {
    h.selects = [[{ ...watch, lastRunId: id, pendingRunId: id }]];
    await changeMinkWatch(actor, { action: "pause", id, version: 1 });
    expect(
      h.writes.find((w) => w.table === minkWorkflowRuns).value
        .cancelRequestedAt,
    ).toBeTruthy();
    expect(h.writes.find((w) => w.table === minkWatches).value).toMatchObject({
      status: "paused",
      pendingRunId: null,
      version: 2,
    });
  });
  it("does not resume after permission narrowing", async () => {
    h.selects = [[{ ...watch, status: "paused" }]];
    h.scopes.mockResolvedValue(null);
    await expect(
      changeMinkWatch(actor, { action: "resume", id, version: 1 }),
    ).rejects.toThrow("permissions");
  });
  it("hides old broad results after scope revocation", async () => {
    h.selects = [[{ ...watch, processedRunId: id }]];
    h.scopes.mockResolvedValue(null);
    const data = await listMinkWatches(actor);
    expect(data.watches[0]).toMatchObject({
      result: null,
      locationLabel: "Scope no longer accessible",
    });
    expect(JSON.stringify(data)).not.toContain("requesterEmail");
  });
});
describe("bounded watch scheduler and outbox", () => {
  it("does no work with the kill switch off", async () => {
    h.enabled = false;
    expect(await scheduleMinkWatches(now)).toBe(0);
    expect(await reconcileMinkWatches(now)).toBe(0);
    expect(h.sql).toEqual([]);
  });
  it("queues snapshot/analyse/finalise with no source model run", async () => {
    h.selects = [[watch]];
    h.inserts = [[{ id }], [], []];
    expect(await scheduleMinkWatches(now)).toBe(1);
    expect(h.writes[0].value).toMatchObject({
      watchId: id,
      template: "business_brief",
      totalSteps: 3,
    });
    expect(h.writes[0].value.sourceRunId).toBeUndefined();
    expect(h.writes[1].value.map((s: any) => s.stepKey)).toEqual([
      "snapshot",
      "analyse",
      "finalise",
    ]);
    expect(h.writes.find((w) => w.table === minkWatches).value.nextRunAt).toBe(
      "2026-09-06T03:30:00.000Z",
    );
  });
  it("pauses due watches on revoked authority", async () => {
    h.selects = [[watch]];
    h.scopes.mockResolvedValue(null);
    expect(await scheduleMinkWatches(now)).toBe(0);
    expect(h.writes[0].value).toMatchObject({
      status: "paused",
      errorCode: "authorization_revoked",
    });
  });
  it("delivers new attention only to the owner, without metric payloads", async () => {
    h.selects = [
      [{ ...watch, lastRunId: id }],
      [{ id, status: "completed", resultJson: result }],
    ];
    expect(await reconcileMinkWatches(now)).toBe(1);
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        restrictToAdminIds: ["admin"],
        deduplicate: true,
        payload: { url: "/dashboard/mink-watches" },
      }),
      db,
    );
    expect(h.writes[0].value.pendingRunId).toBeNull();
  });
  it("suppresses unchanged attention", async () => {
    h.selects = [
      [
        {
          ...watch,
          lastRunId: id,
          fingerprint: "business-brief-v1:sales:attention",
        },
      ],
      [{ status: "completed", resultJson: result }],
    ];
    await reconcileMinkWatches(now);
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("preserves the attention episode through insufficient data without sending stale evidence", async () => {
    h.selects = [
      [
        {
          ...watch,
          lastRunId: id,
          pendingRunId: "old",
          fingerprint: "episode",
        },
      ],
      [
        {
          status: "completed",
          resultJson: {
            ...result,
            signals: [{ key: "sales", status: "insufficient_data" }],
          },
        },
      ],
    ];
    await reconcileMinkWatches(now);
    expect(h.writes[0].value).toMatchObject({
      pendingRunId: null,
      fingerprint: "episode",
    });
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("quiet hours defer, not discard, attention", async () => {
    h.selects = [
      [
        {
          ...watch,
          lastRunId: id,
          scheduleJson: { ...schedule, quietStart: "09:00", quietEnd: "12:00" },
        },
      ],
      [{ id, status: "completed", resultJson: result }],
    ];
    await reconcileMinkWatches(now);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.writes[0].value.pendingRunId).toBe(id);
  });
  it("recovery clears an undelivered alert", async () => {
    h.selects = [
      [{ ...watch, lastRunId: id, pendingRunId: "old", fingerprint: "old" }],
      [
        {
          status: "completed",
          resultJson: {
            ...result,
            signals: [{ key: "sales", status: "no_signal" }],
          },
        },
      ],
    ];
    await reconcileMinkWatches(now);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.writes[0].value.fingerprint).toBeNull();
  });
  it("retains the outbox on notification failure", async () => {
    h.notify.mockResolvedValue(null);
    h.selects = [
      [{ ...watch, lastRunId: id, processedRunId: id, pendingRunId: id }],
      [],
    ];
    expect(await reconcileMinkWatches(now)).toBe(0);
    expect(h.writes[0].value.pendingRunId).toBe(id);
  });
  it("repairs a crash after a committed notification without duplicate fanout", async () => {
    h.notify.mockResolvedValue(null);
    h.selects = [
      [{ ...watch, lastRunId: id, processedRunId: id, pendingRunId: id }],
      [{ id: "existing-event" }],
    ];
    expect(await reconcileMinkWatches(now)).toBe(1);
    expect(h.writes[0].value.pendingRunId).toBeNull();
  });
  it("stops failed checks rather than claiming healthy zeroes", async () => {
    h.selects = [[{ ...watch, lastRunId: id }], [{ status: "failed" }]];
    await reconcileMinkWatches(now);
    expect(h.writes.find((w) => w.table === minkWatches).value).toMatchObject({
      status: "paused",
      errorCode: "check_failed",
    });
    expect(h.notify).not.toHaveBeenCalled();
  });
});
