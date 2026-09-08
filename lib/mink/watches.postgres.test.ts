/** Opt-in concurrency checks against the isolated synthetic 8B migration fixture.
 * Never reads application DB env/credentials. The socket must be a task-owned /tmp
 * fixture; database name is fixed and is not a StoreMink deployment database. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@/drizzle/schema";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { Db } from "@/lib/db/client";
import type { MinkActorContext } from "./types";
const fixture = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("@/lib/db/client", () => ({
  withService: async (fn: (db: unknown) => unknown) => {
    const client = await fixture.pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_service");
      const value = await fn(drizzle(client, { schema }));
      await client.query("COMMIT");
      return value;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
}));
vi.mock("./config", () => ({
  getMinkConfig: () => ({ enabled: true, betaRequireInvite: false }),
}));
vi.mock("./workflows", () => ({
  captureBusinessBriefInput: async () => ({
    period: "daily",
    timeZone: "Asia/Kolkata",
    locationIds: [],
    locationLabel: "Shop",
    includeUnassigned: false,
    requestedAt: new Date().toISOString(),
    currency: "INR",
    defaultLowStockThreshold: 5,
  }),
  revalidateWorkflowAuthority: async () => ({ locationIds: [] }),
}));
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async (event, db: Db) => {
    const result =
      await db.execute(sql`INSERT INTO activity_events(store_id,type,subject_id)
      VALUES (${event.storeId},${event.type},${event.subject.id}) ON CONFLICT DO NOTHING RETURNING id`);
    return result.rows[0]?.id ?? null;
  }),
}));
import {
  changeMinkWatch,
  createMinkWatch,
  scheduleMinkWatches,
  reconcileMinkWatches,
} from "./watches";
const socket = process.env.MINK_WATCH_TEST_SOCKET;
const storeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa8b";
const actor = {
  storeId,
  adminId: "watch-integration-owner",
} as MinkActorContext;
const raw = () => ({
  action: "create",
  kind: "inventory",
  confirmed: true,
  creationKey: crypto.randomUUID(),
  schedule: {
    frequency: "daily",
    time: "09:00",
    weekday: 1,
    quietStart: null,
    quietEnd: null,
  },
});

describe.skipIf(!socket)("watch PostgreSQL locking and atomicity", () => {
  beforeAll(async () => {
    if (!/^\/(?:private\/)?tmp\/mink-[a-zA-Z0-9.-]+$/.test(socket!))
      throw new Error(
        "Only an isolated Mink temporary test socket is permitted.",
      );
    fixture.pool = new Pool({
      host: socket,
      port: 55482,
      database: "mink_8b_verify",
      max: 8,
      types: postgresStringTimestampTypes,
    });
    // The migration probe seeds one intentionally incomplete row to test SQL checks.
    await fixture.pool.query(
      "UPDATE mink_watches SET status='paused' WHERE store_id='11111111-1111-4111-8111-111111111111'",
    );
    // The DDL-only fixture has just the columns needed by migration 0082.
    // Complete the pre-existing step shape before exercising Drizzle inserts.
    await fixture.pool.query(`ALTER TABLE mink_workflow_steps
      ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS attempt_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS output_json jsonb,
      ADD COLUMN IF NOT EXISTS error_code text,
      ADD COLUMN IF NOT EXISTS started_at timestamptz,
      ADD COLUMN IF NOT EXISTS completed_at timestamptz,
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`);
    await fixture.pool.query(
      "INSERT INTO stores(id) VALUES ($1) ON CONFLICT DO NOTHING",
      [storeId],
    );
  });
  beforeEach(async () => {
    await fixture.pool!.query("DELETE FROM mink_watches WHERE store_id=$1", [
      storeId,
    ]);
    await fixture.pool!.query("DELETE FROM activity_events WHERE store_id=$1", [
      storeId,
    ]);
  });
  afterAll(async () => {
    if (fixture.pool) {
      try {
        await fixture.pool.query("DELETE FROM mink_watches WHERE store_id=$1", [
          storeId,
        ]);
        await fixture.pool.query("DELETE FROM stores WHERE id=$1", [storeId]);
        await fixture.pool.query(
          "DELETE FROM activity_events WHERE store_id=$1",
          [storeId],
        );
      } finally {
        await fixture.pool.end();
      }
    }
  });
  it("concurrent creation with the same key creates one watch", async () => {
    const request = raw();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createMinkWatch(actor, request)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(
      (
        await fixture.pool!.query(
          "SELECT count(*)::int n FROM mink_watches WHERE store_id=$1",
          [storeId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("concurrent distinct creates cannot overrun the owner cap", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, () => createMinkWatch(actor, raw())),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });
  it("two heartbeats queue exactly one run with all three steps", async () => {
    const w = await createMinkWatch(actor, raw());
    await fixture.pool!.query(
      "UPDATE mink_watches SET next_run_at=now()-interval '1 minute' WHERE id=$1",
      [w.id],
    );
    const counts = await Promise.all([
      scheduleMinkWatches(),
      scheduleMinkWatches(),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    const runs = await fixture.pool!.query(
      "SELECT id FROM mink_workflow_runs WHERE watch_id=$1",
      [w.id],
    );
    expect(runs.rows).toHaveLength(1);
    expect(
      (
        await fixture.pool!.query(
          "SELECT count(*)::int n FROM mink_workflow_steps WHERE run_id=$1",
          [runs.rows[0].id],
        )
      ).rows[0].n,
    ).toBe(3);
  });
  it("resume waits for the cancelled previous run to leave the queue", async () => {
    const w = await createMinkWatch(actor, raw());
    await fixture.pool!.query(
      "UPDATE mink_watches SET next_run_at=now()-interval '1 minute' WHERE id=$1",
      [w.id],
    );
    await scheduleMinkWatches();
    await changeMinkWatch(actor, { action: "pause", id: w.id, version: 1 });
    await changeMinkWatch(actor, { action: "resume", id: w.id, version: 2 });
    await fixture.pool!.query(
      "UPDATE mink_watches SET next_run_at=now()-interval '1 minute' WHERE id=$1",
      [w.id],
    );
    expect(await scheduleMinkWatches()).toBe(0);
    await fixture.pool!.query(
      "UPDATE mink_workflow_runs SET status='cancelled' WHERE watch_id=$1",
      [w.id],
    );
    expect(await scheduleMinkWatches()).toBe(1);
  });
  it("concurrent outbox reconciliation produces only one private alert", async () => {
    const w = await createMinkWatch(actor, raw());
    await fixture.pool!.query(
      "UPDATE mink_watches SET next_run_at=now()-interval '1 minute' WHERE id=$1",
      [w.id],
    );
    await scheduleMinkWatches();
    const result = {
      rulesVersion: "business-brief-v1",
      signals: [{ key: "inventory", status: "attention" }],
      locations: [{ id: "shop", lowStock: 1, outOfStock: 2 }],
    };
    await fixture.pool!.query(
      "UPDATE mink_workflow_runs SET status='completed',result_json=$2 WHERE watch_id=$1",
      [w.id, JSON.stringify(result)],
    );
    const counts = await Promise.all([
      reconcileMinkWatches(),
      reconcileMinkWatches(),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(
      (
        await fixture.pool!.query(
          "SELECT count(*)::int n FROM activity_events WHERE store_id=$1 AND type='mink.watch_ready'",
          [storeId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});
