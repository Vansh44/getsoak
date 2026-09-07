// @vitest-environment node
/** Opt-in fixture only. Requires empty mink_8d_verify DB on a temporary socket. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";
import type { MinkActorContext } from "./types";
const h = vi.hoisted(() => ({ pool: null as Pool | null, enabled: true }));
vi.mock("@/lib/db/client", () => ({
  withService: async (fn: (db: unknown) => unknown) => {
    const c = await h.pool!.connect();
    try {
      await c.query("BEGIN; SET LOCAL ROLE app_service");
      const result = await fn(drizzle(c));
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
  getMinkConfig: () => ({ enabled: h.enabled, betaRequireInvite: false }),
}));
import {
  changeMinkMemory,
  listMinkMemories,
  loadMinkMemoryReference,
  purgeExpiredMinkMemories,
} from "./memories";
const socket = process.env.MINK_MEMORY_TEST_SOCKET;
const store = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa8d";
const actor: MinkActorContext = {
  storeId: store,
  adminId: "owner",
  permissions: { dashboard: ["view"] },
  locationIds: null,
  roleSlug: "manager",
  isSuperadmin: false,
  email: null,
  effectivePlan: "pro",
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "fixture",
};
const command = () => ({
  action: "save",
  id: crypto.randomUUID(),
  requestKey: crypto.randomUUID(),
  version: 0,
  confirmed: true,
  title: "Echos style",
  content: "Use short clear answers",
  kind: "preference",
  days: 90,
});
describe.skipIf(!socket)("8D isolated PostgreSQL memory contract", () => {
  beforeAll(async () => {
    if (
      !socket ||
      !/^\/(private\/)?tmp\/mink-8d-pg\.[a-zA-Z0-9]+$/.test(socket)
    )
      throw new Error("Use a task-owned temporary socket");
    h.pool = new Pool({
      host: socket,
      port: 55484,
      database: "mink_8d_verify",
      max: 5,
      types: postgresStringTimestampTypes,
    });
    if (
      (await h.pool.query("select to_regclass('stores') as found")).rows[0]
        .found
    )
      throw new Error("Use a fresh empty fixture database");
    await h.pool
      .query(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_user') THEN CREATE ROLE app_user; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_service') THEN CREATE ROLE app_service BYPASSRLS; END IF; END $$;
      CREATE TABLE stores(id uuid PRIMARY KEY); CREATE TABLE help_articles(id uuid DEFAULT gen_random_uuid(),slug text,status text,category_id uuid,body text,updated_at timestamptz);
      INSERT INTO help_articles(slug,status,category_id,body) VALUES('use-mink-ai-in-your-dashboard','published',gen_random_uuid(),'Existing guide');`);
    const migration = readFileSync(
      new URL(
        "../../drizzle/migrations/sql/20260907_0084_mink_phase_8d_memories.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const c = await h.pool.connect();
    try {
      await c.query("BEGIN; UPDATE help_articles SET status='draft'");
      await expect(c.query(migration)).rejects.toThrow(
        "guidance was not installed",
      );
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(
      (await h.pool.query("select to_regclass('mink_memories') as found"))
        .rows[0].found,
    ).toBeNull();
    await h.pool.query(migration);
    await h.pool.query(migration);
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../drizzle/migrations/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    const entry = manifest.migrations.find(
      (m: { id: string }) => m.id === "20260907_0084_mink_phase_8d_memories",
    );
    for (const q of [...entry.verify.queries, ...entry.adoptVerify.queries])
      expect(
        String(Object.values((await h.pool.query(q.sql)).rows[0])[0]),
        q.name,
      ).toBe(q.equals);
    await h.pool.query("INSERT INTO stores VALUES($1)", [store]);
  });
  beforeEach(async () => {
    h.enabled = true;
    await h.pool!.query(
      "DELETE FROM mink_memories; DELETE FROM mink_memory_deletions",
    );
  });
  afterAll(async () => {
    await h.pool?.end();
  });
  it("concurrent exact retries create one approved version", async () => {
    const c = command();
    const [a, b] = await Promise.all([
      changeMinkMemory(actor, c),
      changeMinkMemory(actor, c),
    ]);
    expect(a).toEqual(b);
    expect(await listMinkMemories(actor)).toHaveLength(1);
    expect((await listMinkMemories(actor))[0].version).toBe(1);
  });
  it("two editors cannot overwrite each other's approved text", async () => {
    const c = command();
    await changeMinkMemory(actor, c);
    const results = await Promise.allSettled([
      changeMinkMemory(actor, {
        ...c,
        version: 1,
        requestKey: crypto.randomUUID(),
        content: "A",
      }),
      changeMinkMemory(actor, {
        ...c,
        version: 1,
        requestKey: crypto.randomUUID(),
        content: "B",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listMinkMemories(actor))[0].version).toBe(2);
  });
  it("enforces the ten-memory cap under concurrent creation", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => changeMinkMemory(actor, command())),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(await listMinkMemories(actor)).toHaveLength(10);
  });
  it("isolates owner and tenant IDs including attempted ID collision", async () => {
    const c = command();
    await changeMinkMemory(actor, c);
    const other = { ...actor, adminId: "other" };
    expect(await listMinkMemories(other)).toEqual([]);
    await expect(changeMinkMemory(other, c)).rejects.toMatchObject({
      status: 409,
    });
    await changeMinkMemory(other, {
      action: "delete",
      id: c.id,
      version: 1,
      confirmed: true,
    });
    expect(await listMinkMemories(actor)).toHaveLength(1);
    expect(
      await listMinkMemories({
        ...actor,
        storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb8d",
      }),
    ).toEqual([]);
  });
  it("deletion removes text and cannot be undone by a delayed original request", async () => {
    const c = command();
    await changeMinkMemory(actor, c);
    await changeMinkMemory(actor, {
      action: "delete",
      id: c.id,
      version: 1,
      confirmed: true,
    });
    expect(await listMinkMemories(actor)).toEqual([]);
    await expect(changeMinkMemory(actor, c)).rejects.toMatchObject({
      code: "memory_deleted",
    });
    expect(
      (await h.pool!.query("SELECT count(*)::int n FROM mink_memories")).rows[0]
        .n,
    ).toBe(0);
  });
  it("withholds scope-changed memories until explicit fresh approval", async () => {
    const c = command();
    await changeMinkMemory(actor, c);
    const changed = {
      ...actor,
      locationIds: ["11111111-1111-4111-8111-111111111111"],
    };
    expect(await loadMinkMemoryReference(changed)).toBe("");
    expect((await listMinkMemories(changed))[0].usable).toBe(false);
    await changeMinkMemory(changed, {
      ...c,
      version: 1,
      requestKey: crypto.randomUUID(),
    });
    expect(await loadMinkMemoryReference(changed)).toContain(
      "Use short clear answers",
    );
  });
  it("expires logically and physically; old retries cannot renew it after purge", async () => {
    const c = command();
    await changeMinkMemory(actor, c);
    await h.pool!.query(
      "UPDATE mink_memories SET expires_at=now()-interval '1 second'",
    );
    expect(await loadMinkMemoryReference(actor)).toBe("");
    await purgeExpiredMinkMemories();
    expect(
      (await h.pool!.query("SELECT count(*)::int n FROM mink_memories")).rows[0]
        .n,
    ).toBe(0);
    await expect(changeMinkMemory(actor, c)).rejects.toMatchObject({
      code: "memory_deleted",
    });
  });
  it("keeps deletion available while generation is disabled", async () => {
    await changeMinkMemory(actor, command());
    h.enabled = false;
    await expect(changeMinkMemory(actor, command())).rejects.toMatchObject({
      status: 403,
    });
    await changeMinkMemory(actor, { action: "delete_all", confirmed: true });
    expect(await listMinkMemories(actor)).toEqual([]);
  });
  it("delete-all racing with expiry cleanup removes text without a lock-order deadlock", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => changeMinkMemory(actor, command())),
    );
    await h.pool!.query(
      "UPDATE mink_memories SET expires_at=now()-interval '1 second'",
    );
    await Promise.all([
      purgeExpiredMinkMemories(),
      changeMinkMemory(actor, { action: "delete_all", confirmed: true }),
    ]);
    expect(
      (await h.pool!.query("SELECT count(*)::int n FROM mink_memories")).rows[0]
        .n,
    ).toBe(0);
    expect(
      (await h.pool!.query("SELECT count(*)::int n FROM mink_memory_deletions"))
        .rows[0].n,
    ).toBe(10);
  });
  it("bulk deletion leaves another owner's context intact", async () => {
    const other = { ...actor, adminId: "other" };
    await changeMinkMemory(actor, command());
    await changeMinkMemory(other, command());
    await changeMinkMemory(actor, { action: "delete_all", confirmed: true });
    expect(await listMinkMemories(actor)).toEqual([]);
    expect(await listMinkMemories(other)).toHaveLength(1);
  });
  it("rejects writes lacking literal consent without creating a record", async () => {
    await expect(
      changeMinkMemory(actor, { ...command(), confirmed: "true" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await listMinkMemories(actor)).toEqual([]);
  });
  it("denies browser roles direct reads", async () => {
    const c = await h.pool!.connect();
    try {
      await c.query("BEGIN; SET LOCAL ROLE app_user");
      await expect(c.query("SELECT * FROM mink_memories")).rejects.toThrow();
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});
