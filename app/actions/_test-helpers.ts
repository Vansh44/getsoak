/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Supabase query chains. Each call returns `this`, so you can chain
// freely. There are two distinct terminal shapes:
//
//   - `.single()` / `.maybeSingle()` resolve to `singleResult` (a single row)
//   - awaiting the chain directly (insert/update/delete/list select) resolves
//     to `listResult` (a list / count / status response)
//
// Splitting them lets a single mock serve both an `.select().like()` slug
// lookup AND an `.insert().select().single()` row insert without conflict.
// ---------------------------------------------------------------------------

export interface ChainMock {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  neq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  contains: ReturnType<typeof vi.fn>;
  like: ReturnType<typeof vi.fn>;
  ilike: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  gt: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  lte: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  range: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (resolve: any) => any;
}

/**
 * Fluent Supabase chain.
 *   singleResult — what `.single()` / `.maybeSingle()` resolve to.
 *   listResult   — what awaiting the chain directly (no terminal) resolves to.
 */
export function makeChain(
  singleResult: any = { data: null, error: null },
  listResult: any = { data: [], error: null },
): ChainMock {
  const chain: any = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    upsert: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    in: vi.fn(() => chain),
    contains: vi.fn(() => chain),
    like: vi.fn(() => chain),
    ilike: vi.fn(() => chain),
    or: vi.fn(() => chain),
    not: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    lt: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    range: vi.fn(() => chain),
    single: vi.fn().mockResolvedValue(singleResult),
    maybeSingle: vi.fn().mockResolvedValue(singleResult),
    // Awaiting the chain directly (no terminal) — used by list selects,
    // update().eq(), delete().eq(), insert without .select(), etc.
    then: (resolve: any) => Promise.resolve(listResult).then(resolve),
  };
  return chain;
}

/**
 * Routes `.from(table)` to a per-table chain so a single action can drive
 * multiple tables in one test.
 *
 * Example:
 *   const supabase = makeSupabase({
 *     blogs: makeChain({ data: { id: 1 }, error: null }),
 *     customers: makeChain({ data: { first_name: "A" }, error: null }),
 *   });
 */
// ---------------------------------------------------------------------------
// Mock Drizzle db (GCP migration Phase 5). Mirrors the fragment of the Drizzle
// query API our ported server actions use, recording the args so tests can
// assert on insert/update payloads without a real database. Pair it with a
// mock of `@/lib/db/client` whose with* runners invoke the callback with .db:
//
//   const dbHolder = vi.hoisted(() => ({ current: null as any }));
//   vi.mock("@/lib/db/client", () => ({
//     // Promise.resolve() assimilates the thenable query steps into REAL
//     // promises, so action code may call .catch() on a with* result.
//     withUser: vi.fn((_id: any, fn: any) =>
//       Promise.resolve(fn(dbHolder.current.db))),
//     withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
//     withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
//   }));
//   beforeEach(() => { dbHolder.current = makeDbMock({ returning: [{ id: "c1" }] }); });
// ---------------------------------------------------------------------------

export interface DbMock {
  db: any;
  calls: {
    insert: any[];
    values: any[];
    update: any[];
    set: any[];
    delete: any[];
    where: any[];
    select: any[];
    onConflict: any[];
    execute: any[];
    limit: any[];
    offset: any[];
    forUpdate: any[];
    innerJoin: any[];
    leftJoin: any[];
  };
}

export function makeDbMock(
  opts: {
    returning?: any[];
    // Optional per-write returning rows. Each .returning() consumes one entry;
    // useful when one action performs multiple conditional updates.
    returningQueue?: any[][];
    // An `Error` entry makes THAT select reject — for testing how an action
    // reports a failed read. Needed once reads run concurrently: which batch
    // failed decides which message the user sees.
    selectQueue?: (any[] | Error)[];
    executeQueue?: any[][];
    // Tables whose insert().values(...) / update().set(...).where(...) should
    // REJECT when awaited — for rollback-path tests. Compare by table identity.
    failInsertFor?: any[];
    failUpdateFor?: any[];
  } = {},
): DbMock {
  const returning = opts.returning ?? [{ id: "row-1" }];
  const returningQueue = [...(opts.returningQueue ?? [])];
  const failInsertFor = opts.failInsertFor ?? [];
  const failUpdateFor = opts.failUpdateFor ?? [];
  // A step whose await / terminals reject — models a failing write.
  const failStep = (): any => ({
    where: vi.fn(() => failStep()),
    returning: vi.fn(() => Promise.reject(new Error("db write failed"))),
    then: (_res: any, rej: any) => rej(new Error("db write failed")),
  });
  // Each db.select() consumes the next entry (an action doing a slug lookup
  // then an image prefetch gets queue[0] then queue[1]); empty queue → [].
  const selectQueue = [...(opts.selectQueue ?? [])];
  // Each db.execute() (raw-SQL RPC calls) consumes the next `.rows` entry.
  const executeQueue = [...(opts.executeQueue ?? [])];
  const calls: DbMock["calls"] = {
    insert: [],
    values: [],
    update: [],
    set: [],
    delete: [],
    where: [],
    select: [],
    onConflict: [],
    execute: [],
    limit: [],
    offset: [],
    forUpdate: [],
    innerJoin: [],
    leftJoin: [],
  };

  // A thenable step that also exposes .where()/.returning() terminals, so both
  // `await db.update().set().where()` and `db.insert().values().returning()`
  // resolve correctly.
  const step = (result: any): any => ({
    where: vi.fn((c: any) => {
      calls.where.push(c);
      return step(result);
    }),
    onConflictDoUpdate: vi.fn((c: any) => {
      calls.onConflict.push(c);
      return step(result);
    }),
    onConflictDoNothing: vi.fn((c: any) => {
      calls.onConflict.push(c);
      return step(result);
    }),
    returning: vi.fn(async () =>
      returningQueue.length ? returningQueue.shift()! : returning,
    ),
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  });

  // A fully-chainable select step; awaiting it resolves to `rows`.
  const selectStep = (rows: any[] | Error): any => {
    const s: any = {
      from: vi.fn(() => s),
      where: vi.fn((c: any) => {
        calls.where.push(c);
        return s;
      }),
      leftJoin: vi.fn((...args: any[]) => {
        calls.leftJoin.push(args);
        return s;
      }),
      innerJoin: vi.fn((...args: any[]) => {
        calls.innerJoin.push(args);
        return s;
      }),
      groupBy: vi.fn(() => s),
      orderBy: vi.fn(() => s),
      limit: vi.fn((n: any) => {
        calls.limit.push(n);
        return s;
      }),
      offset: vi.fn((n: any) => {
        calls.offset.push(n);
        return s;
      }),
      // SELECT ... FOR UPDATE — the row lock refund-actions takes so two
      // concurrent refunds on one order serialise instead of both passing the
      // cap. Recorded so a test can assert the lock is still there.
      for: vi.fn((mode: any) => {
        calls.forUpdate.push(mode);
        return s;
      }),
      then: (resolve: any, reject: any) =>
        rows instanceof Error
          ? Promise.reject(rows).then(resolve, reject)
          : Promise.resolve(rows).then(resolve),
    };
    return s;
  };

  const db: any = {
    select: vi.fn((projection?: any) => {
      calls.select.push(projection);
      return selectStep(selectQueue.length ? selectQueue.shift()! : []);
    }),
    execute: vi.fn(async (query: any) => {
      calls.execute.push(query);
      return { rows: executeQueue.length ? executeQueue.shift()! : [] };
    }),
    insert: vi.fn((t: any) => {
      calls.insert.push(t);
      const fail = failInsertFor.includes(t);
      return {
        values: vi.fn((v: any) => {
          calls.values.push(v);
          return fail ? failStep() : step(returning);
        }),
      };
    }),
    update: vi.fn((t: any) => {
      calls.update.push(t);
      const fail = failUpdateFor.includes(t);
      return {
        set: vi.fn((v: any) => {
          calls.set.push(v);
          return fail ? failStep() : step({ rowCount: 1 });
        }),
      };
    }),
    delete: vi.fn((t: any) => {
      calls.delete.push(t);
      return step({ rowCount: 1 });
    }),
  };

  return { db, calls };
}

/**
 * The bound parameter VALUES of a Drizzle SQL object, in order — lets tests
 * assert what a raw-SQL RPC call (db.execute) was invoked with. In a sql``
 * template, interpolated values sit INLINE in queryChunks as raw primitives
 * (incl. null); literal SQL text is a StringChunk whose `value` is an array.
 */
export function sqlParamValues(sqlObj: any): any[] {
  const out: any[] = [];
  const walk = (chunk: any) => {
    if (chunk === null || typeof chunk !== "object") {
      out.push(chunk); // a raw bound value
      return;
    }
    if (Array.isArray(chunk)) {
      chunk.forEach(walk);
      return;
    }
    if (chunk.queryChunks) {
      walk(chunk.queryChunks); // nested SQL
      return;
    }
    if (Array.isArray(chunk.value)) return; // StringChunk (literal SQL text)
    if ("value" in chunk) out.push(chunk.value); // Param wrapper
  };
  if (sqlObj?.queryChunks) walk(sqlObj.queryChunks);
  return out;
}

/**
 * The literal SQL text of a Drizzle sql`` object (the StringChunk pieces joined),
 * so a test can tell WHICH raw-SQL RPC a db.execute() call ran — e.g.
 * `sqlText(call).includes("increment_coupon_usage")`.
 */
export function sqlText(sqlObj: any): string {
  let out = "";
  const walk = (chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return;
    if (Array.isArray(chunk)) {
      chunk.forEach(walk);
      return;
    }
    if (chunk.queryChunks) {
      walk(chunk.queryChunks);
      return;
    }
    if (Array.isArray(chunk.value)) out += chunk.value.join(""); // StringChunk
  };
  if (sqlObj?.queryChunks) walk(sqlObj.queryChunks);
  return out;
}

export function makeSupabase(
  tables: Record<string, ChainMock> = {},
  user: any = { id: "user-1" },
) {
  const from = vi.fn((table: string) => {
    if (!tables[table]) tables[table] = makeChain();
    return tables[table];
  });
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      updateUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      refreshSession: vi.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      admin: {
        createUser: vi.fn().mockResolvedValue({
          data: { user: { id: "new-user" } },
          error: null,
        }),
        deleteUser: vi.fn().mockResolvedValue({ error: null }),
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
      },
    },
    from,
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    storage: {
      from: vi.fn().mockReturnValue({
        remove: vi.fn().mockResolvedValue({ error: null }),
        download: vi.fn().mockResolvedValue({ data: null, error: null }),
        upload: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    },
    _tables: tables,
  } as any;
}
