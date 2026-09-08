// @vitest-environment node
/** Opt-in isolated PostgreSQL fixture. Never reads application DB credentials.
 * Use a fresh mink_8c_verify database on a task-owned Unix socket, no TCP. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/drizzle/schema";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { MinkActorContext } from "./types";
const h = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("@/lib/db/client", () => ({
  withService: async (fn: (db: unknown) => unknown) => {
    const c = await h.pool!.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE app_service");
      const result = await fn(drizzle(c, { schema }));
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
}));
vi.mock("./config", () => ({
  getMinkConfig: () => ({ enabled: true, betaRequireInvite: false }),
}));
vi.mock("./workflows", () => ({
  revalidateWorkflowAuthority: async () => ({ locationIds: [] }),
  captureBusinessBriefInput: vi.fn(),
}));
import {
  listProactiveResponses,
  decideProactiveResponse,
} from "./proactive-responses";
import { changeMinkWatch } from "./watches";
const socket = process.env.MINK_RESPONSE_TEST_SOCKET;
const store = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa8c",
  watch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb8c",
  source = "cccccccc-cccc-4ccc-8ccc-cccccccccc8c";
const actor = {
  storeId: store,
  adminId: "8c-fixture-owner",
} as MinkActorContext;
const input = {
  period: "daily",
  timeZone: "Asia/Kolkata",
  locationIds: [],
  locationLabel: "Shop and Delhi",
  includeUnassigned: false,
  defaultLowStockThreshold: 5,
};
const result = {
  dataAsOf: new Date().toISOString(),
  locationLabel: "Shop and Delhi",
  timeZone: "Asia/Kolkata",
  rangeLabel: "Yesterday",
  signals: [
    { key: "inventory", status: "attention", evidence: "2 empty shelves" },
    {
      key: "payments",
      status: "attention",
      evidence: "4 orders with failed payments",
    },
  ],
};
describe.skipIf(!socket)(
  "Phase 8C PostgreSQL migration and approval atomicity",
  () => {
    beforeAll(async () => {
      if (
        !socket ||
        !/^\/(private\/)?tmp\/mink-8c-pg\.[a-zA-Z0-9]+$/.test(socket)
      )
        throw new Error("Use an isolated task-owned socket");
      h.pool = new Pool({
        host: socket,
        port: 55483,
        database: "mink_8c_verify",
        max: 4,
        types: postgresStringTimestampTypes,
      });
      if (
        (await h.pool.query("select to_regclass('public.stores') as existing"))
          .rows[0].existing
      )
        throw new Error("Fixture requires a fresh empty test database");
      await h.pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_user') THEN CREATE ROLE app_user; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_service') THEN CREATE ROLE app_service BYPASSRLS; END IF;
      END $$;
      CREATE TABLE stores(id uuid PRIMARY KEY);
      CREATE TABLE help_articles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),slug text,status text,category_id uuid,body text,updated_at timestamptz);
      CREATE TABLE activity_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),store_id uuid,type text,subject_id text);
      CREATE TABLE mink_workflow_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),store_id uuid NOT NULL,admin_id text NOT NULL,source_run_id uuid,template text NOT NULL,status text NOT NULL DEFAULT 'queued',idempotency_key text NOT NULL,input_json jsonb NOT NULL DEFAULT '{}',result_json jsonb,error_code text,error_detail text,current_step integer NOT NULL DEFAULT 0,total_steps integer NOT NULL,attempt_count integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 6,run_after timestamptz NOT NULL DEFAULT now(),lease_owner uuid,lease_expires_at timestamptz,cancel_requested_at timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,store_id),UNIQUE(store_id,admin_id,idempotency_key));
      CREATE TABLE mink_workflow_steps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid REFERENCES mink_workflow_runs(id) ON DELETE CASCADE,store_id uuid,step_key text,position integer,status text DEFAULT 'queued',attempt_count integer DEFAULT 0,input_json jsonb DEFAULT '{}',output_json jsonb,error_code text,started_at timestamptz,completed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      INSERT INTO help_articles(slug,status,category_id,body) VALUES('use-mink-ai-in-your-dashboard','published',gen_random_uuid(),'Recurring watches are a later phase.');`);
      const sql8b = readFileSync(
        new URL(
          "../../drizzle/migrations/sql/20260905_0082_mink_phase_8b_watches.sql",
          import.meta.url,
        ),
        "utf8",
      );
      const sql8c = readFileSync(
        new URL(
          "../../drizzle/migrations/sql/20260906_0083_mink_phase_8c_responses.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await h.pool.query(sql8b);
      // Missing guide must roll the entire migration back, not leave the table installed.
      const c = await h.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("UPDATE help_articles SET status='draft'");
        await expect(c.query(sql8c)).rejects.toThrow(
          "guidance was not installed",
        );
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      expect(
        (
          await h.pool.query(
            "select to_regclass('public.mink_watch_responses') as found",
          )
        ).rows[0].found,
      ).toBeNull();
      await h.pool.query(sql8c);
      await h.pool.query(sql8c);
      const manifest = JSON.parse(
        readFileSync(
          new URL("../../drizzle/migrations/manifest.json", import.meta.url),
          "utf8",
        ),
      );
      const migration = manifest.migrations.find(
        (m: { id: string }) => m.id === "20260906_0083_mink_phase_8c_responses",
      );
      for (const q of [
        ...migration.verify.queries,
        ...migration.adoptVerify.queries,
      ])
        expect(
          String(Object.values((await h.pool.query(q.sql)).rows[0])[0]),
          q.name,
        ).toBe(q.equals);
      await h.pool.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app_service",
      );
      await h.pool.query("INSERT INTO stores VALUES($1)", [store]);
    }, 20000);
    beforeEach(async () => {
      await h.pool!.query("DELETE FROM mink_watches WHERE store_id=$1", [
        store,
      ]);
      await h.pool!.query(
        "INSERT INTO mink_watches(id,store_id,admin_id,creation_key,kind,schedule_json,input_json,next_run_at) VALUES($1,$2,$3,gen_random_uuid(),'brief',$4,$5,now()+interval '1 day')",
        [
          watch,
          store,
          actor.adminId,
          {
            frequency: "daily",
            time: "09:00",
            weekday: 1,
            quietStart: null,
            quietEnd: null,
          },
          input,
        ],
      );
      await h.pool!.query(
        "INSERT INTO mink_workflow_runs(id,store_id,admin_id,watch_id,template,status,idempotency_key,input_json,result_json,total_steps,completed_at) VALUES($1,$2,$3,$4,'business_brief','completed','fixture',$5,$6,3,now())",
        [source, store, actor.adminId, watch, input, result],
      );
      await h.pool!.query(
        "UPDATE mink_watches SET last_run_id=$1,processed_run_id=$1 WHERE id=$2",
        [source, watch],
      );
    });
    afterAll(async () => {
      await h.pool?.end();
    });
    async function request(signal = "inventory") {
      const p = (await listProactiveResponses(actor, watch)).plans.find(
        (p) => p.signal === signal,
      )!;
      return {
        action: "approve",
        watchId: watch,
        sourceRunId: source,
        signal,
        planHash: p.planHash,
        confirmed: true,
      };
    }
    it("concurrent exact approvals create one workflow and two steps", async () => {
      const r = await request();
      const [a, b] = await Promise.all([
        decideProactiveResponse(actor, r),
        decideProactiveResponse(actor, r),
      ]);
      expect(a.workflowId).toBe(b.workflowId);
      expect(
        (
          await h.pool!.query(
            "SELECT count(*)::int AS n FROM mink_workflow_runs WHERE template='watch_response_review'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await h.pool!.query(
            "SELECT count(*)::int AS n FROM mink_workflow_steps WHERE run_id=$1",
            [a.workflowId],
          )
        ).rows[0].n,
      ).toBe(2);
    });
    it("two different plans cannot launch concurrent responses", async () => {
      const a = await request(),
        b = await request("payments");
      const outcomes = await Promise.allSettled([
        decideProactiveResponse(actor, a),
        decideProactiveResponse(actor, b),
      ]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    });
    it("a step insertion failure rolls back workflow and decision", async () => {
      const r = await request();
      await h.pool!.query(
        "CREATE FUNCTION reject_8c_step() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture failure''; END'; CREATE TRIGGER reject_8c_step BEFORE INSERT ON mink_workflow_steps FOR EACH ROW EXECUTE FUNCTION reject_8c_step()",
      );
      try {
        await expect(decideProactiveResponse(actor, r)).rejects.toThrow();
        expect(
          (
            await h.pool!.query(
              "SELECT count(*)::int AS n FROM mink_watch_responses",
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await h.pool!.query(
              "SELECT count(*)::int AS n FROM mink_workflow_runs WHERE template='watch_response_review'",
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await h.pool!.query(
          "DROP TRIGGER reject_8c_step ON mink_workflow_steps; DROP FUNCTION reject_8c_step()",
        );
      }
    });
    it("pause racing with approval leaves no runnable uncancelled response", async () => {
      const r = await request();
      await Promise.allSettled([
        decideProactiveResponse(actor, r),
        changeMinkWatch(actor, { action: "pause", id: watch, version: 1 }),
      ]);
      expect(
        (
          await h.pool!.query("SELECT status FROM mink_watches WHERE id=$1", [
            watch,
          ])
        ).rows[0].status,
      ).toBe("paused");
      expect(
        (
          await h.pool!.query(
            "SELECT count(*)::int AS n FROM mink_workflow_runs WHERE template='watch_response_review' AND cancel_requested_at IS NULL",
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it("browser role cannot read response decisions", async () => {
      const c = await h.pool!.connect();
      try {
        await c.query("BEGIN; SET LOCAL ROLE app_user");
        await expect(
          c.query("SELECT * FROM mink_watch_responses"),
        ).rejects.toThrow();
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
    });
    it("rejects a cross-tenant response binding", async () => {
      await expect(
        h.pool!.query(
          "INSERT INTO mink_watch_responses(store_id,watch_id,admin_id,source_run_id,signal,watch_version,plan_hash,status) VALUES(gen_random_uuid(),$1,'other',$2,'inventory',1,'hash','dismissed')",
          [watch, source],
        ),
      ).rejects.toThrow();
    });
  },
);
