import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { getMinkConfig } from "./config";
import { getMinkStoreAccess } from "./access";
import { MinkRequestError } from "./errors";
import type { MinkActorContext } from "./types";
import {
  MEMORY_LIMIT,
  parseMemoryCommand,
  memoryReference,
  type ApprovedMemory,
} from "./memory-policy";

function scopeHash(actor: MinkActorContext) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        superadmin: actor.isSuperadmin,
        role: actor.roleSlug,
        locations: [...(actor.locationIds ?? [])].sort(),
        permissions: Object.entries(actor.permissions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, [...v].sort()]),
      }),
    )
    .digest("hex");
}
type Row = {
  id: string;
  title: string;
  content: string;
  kind: ApprovedMemory["kind"];
  version: number;
  scope_hash: string;
  request_key: string;
  request_hash: string;
  expires_at: string;
  updated_at: string;
};
function view(row: Row, scope: string): ApprovedMemory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    kind: row.kind,
    version: row.version,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    usable: row.scope_hash === scope && Date.parse(row.expires_at) > Date.now(),
  };
}
export async function listMinkMemories(
  actor: MinkActorContext,
): Promise<ApprovedMemory[]> {
  return withService(async (db) => {
    const result = await db.execute(
      sql`SELECT * FROM mink_memories WHERE store_id=${actor.storeId} AND admin_id=${actor.adminId} AND expires_at > now() ORDER BY updated_at DESC, id LIMIT ${MEMORY_LIMIT}`,
    );
    return (result.rows as Row[]).map((row) => view(row, scopeHash(actor)));
  });
}
export async function loadMinkMemoryReference(actor: MinkActorContext) {
  return memoryReference(await listMinkMemories(actor));
}
export async function changeMinkMemory(
  actor: MinkActorContext,
  raw: Record<string, unknown>,
) {
  let command: ReturnType<typeof parseMemoryCommand>;
  try {
    command = parseMemoryCommand(raw);
  } catch (e) {
    throw new MinkRequestError(
      "invalid_memory",
      e instanceof Error ? e.message : "Invalid memory.",
      400,
    );
  }
  return withService(async (db) => {
    // Serializes cap enforcement and edits per tenant/owner, without a shared store row lock.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mink-memory:${actor.storeId}:${actor.adminId}`},0))`,
    );
    const scope = scopeHash(actor);
    if (command.action === "delete_all") {
      await db.execute(
        sql`WITH removed AS (DELETE FROM mink_memories WHERE store_id=${actor.storeId} AND admin_id=${actor.adminId} RETURNING id,store_id,admin_id) INSERT INTO mink_memory_deletions (id,store_id,admin_id) SELECT id,store_id,admin_id FROM removed ON CONFLICT DO NOTHING`,
      );
      return { deleted: true };
    }
    const rows = await db.execute(
      sql`SELECT * FROM mink_memories WHERE store_id=${actor.storeId} AND admin_id=${actor.adminId} AND id=${command.id}::uuid FOR UPDATE`,
    );
    const existing = rows.rows[0] as Row | undefined;
    if (command.action === "delete") {
      if (existing && existing.version !== command.version)
        throw new MinkRequestError(
          "memory_conflict",
          "This memory changed. Refresh before deleting it.",
          409,
        );
      if (existing)
        await db.execute(
          sql`INSERT INTO mink_memory_deletions (id,store_id,admin_id) VALUES (${command.id}::uuid,${actor.storeId},${actor.adminId}) ON CONFLICT DO NOTHING`,
        );
      await db.execute(
        sql`DELETE FROM mink_memories WHERE store_id=${actor.storeId} AND admin_id=${actor.adminId} AND id=${command.id}::uuid`,
      );
      return { deleted: true };
    }
    const config = getMinkConfig();
    if (
      !config.enabled ||
      (config.betaRequireInvite &&
        !(await getMinkStoreAccess(actor.storeId, db)).enabled)
    )
      throw new MinkRequestError(
        "memory_disabled",
        "Mink access is required to approve a memory. Deletion remains available.",
        403,
      );
    const deleted = await db.execute(
      sql`SELECT id FROM mink_memory_deletions WHERE id=${command.id}::uuid AND store_id=${actor.storeId} AND admin_id=${actor.adminId} LIMIT 1`,
    );
    if (deleted.rows.length)
      throw new MinkRequestError(
        "memory_deleted",
        "This memory was deleted. Create a new memory if you want to approve it again.",
        409,
      );
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ ...command, scope }))
      .digest("hex");
    if (existing?.request_key === command.requestKey) {
      if (existing.request_hash !== requestHash)
        throw new MinkRequestError(
          "memory_conflict",
          "This save request was already used for different content.",
          409,
        );
      return { memory: view(existing, scope) };
    }
    if ((existing?.version ?? 0) !== command.version)
      throw new MinkRequestError(
        "memory_conflict",
        "This memory changed or was deleted. Refresh before saving.",
        409,
      );
    await db.execute(
      sql`WITH removed AS (DELETE FROM mink_memories WHERE store_id=${actor.storeId} AND admin_id=${actor.adminId} AND expires_at <= now() AND id <> ${command.id}::uuid RETURNING id,store_id,admin_id) INSERT INTO mink_memory_deletions (id,store_id,admin_id) SELECT id,store_id,admin_id FROM removed ON CONFLICT DO NOTHING`,
    );
    if (!existing) {
      const count = await db.execute(
        sql`SELECT count(*)::int AS n FROM mink_memories WHERE store_id=${actor.storeId} AND admin_id=${actor.adminId}`,
      );
      if (Number(count.rows[0].n) >= MEMORY_LIMIT)
        throw new MinkRequestError(
          "memory_limit",
          "You can keep 10 memories. Delete one first.",
          409,
        );
    }
    const result =
      await db.execute(sql`INSERT INTO mink_memories (id,store_id,admin_id,title,content,kind,version,scope_hash,request_key,request_hash,expires_at)
      VALUES (${command.id}::uuid,${actor.storeId},${actor.adminId},${command.title},${command.content},${command.kind},1,${scope},${command.requestKey}::uuid,${requestHash},now()+make_interval(days=>${command.days}))
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, content=EXCLUDED.content, kind=EXCLUDED.kind, version=mink_memories.version+1, scope_hash=EXCLUDED.scope_hash, request_key=EXCLUDED.request_key, request_hash=EXCLUDED.request_hash, expires_at=EXCLUDED.expires_at, updated_at=now()
      WHERE mink_memories.store_id=${actor.storeId} AND mink_memories.admin_id=${actor.adminId} AND mink_memories.version=${command.version}
      RETURNING *`);
    if (!result.rows[0])
      throw new MinkRequestError(
        "memory_conflict",
        "This memory is not available. Refresh and try again.",
        409,
      );
    return { memory: view(result.rows[0] as Row, scope) };
  });
}
/** Bounded physical expiry cleanup; logical expiry applies even if cron is unavailable. */
export async function purgeExpiredMinkMemories() {
  return withService((db) =>
    db.execute(
      sql`WITH removed AS (DELETE FROM mink_memories WHERE id IN (SELECT id FROM mink_memories WHERE expires_at <= now() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED) RETURNING id,store_id,admin_id) INSERT INTO mink_memory_deletions (id,store_id,admin_id) SELECT id,store_id,admin_id FROM removed ON CONFLICT DO NOTHING`,
    ),
  );
}
