import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  activityEvents,
  minkWatches,
  minkWatchEvents,
  minkWorkflowRuns,
  minkWorkflowSteps,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { recordEvent } from "@/lib/notifications/record";
import { getMinkConfig } from "./config";
import { getMinkStoreAccess } from "./access";
import { MinkRequestError } from "./errors";
import type { MinkActorContext } from "./types";
import type {
  BusinessBriefInput,
  BusinessBriefResult,
} from "./business-brief-types";
import {
  captureBusinessBriefInput,
  revalidateWorkflowAuthority,
} from "./workflows";
import { resolveMinkLocation } from "./tools/location-scope";
import {
  inWatchQuietHours,
  nextWatchTime,
  readWatchSchedule,
  watchFingerprint,
  WATCH_KINDS,
  type WatchKind,
  type WatchSchedule,
} from "./watch-policy";

type Watch = typeof minkWatches.$inferSelect;
export interface WatchView {
  id: string;
  kind: string;
  status: string;
  version: number;
  schedule: WatchSchedule;
  timeZone: string;
  locationLabel: string;
  nextRunAt: string;
  lastAlertAt: string | null;
  errorCode: string | null;
  result: BusinessBriefResult | null;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message: string, status = 400): never => {
  throw new MinkRequestError("watch_request_rejected", message, status);
};
function owner(actor: MinkActorContext) {
  return and(
    eq(minkWatches.storeId, actor.storeId),
    eq(minkWatches.adminId, actor.adminId),
  );
}
async function authorized(w: Watch, db?: Db) {
  const config = getMinkConfig();
  if (
    !config.enabled ||
    (config.betaRequireInvite &&
      !(await getMinkStoreAccess(w.storeId, db)).enabled)
  )
    return null;
  return revalidateWorkflowAuthority(
    {
      storeId: w.storeId,
      adminId: w.adminId,
      template: "business_brief",
      inputJson: w.inputJson,
    },
    true,
    db,
  );
}
async function audit(db: Db, w: Watch, event: string, version = w.version) {
  await db.insert(minkWatchEvents).values({ watchId: w.id, event, version });
}
async function stop(
  db: Db,
  w: Watch,
  status: "paused" | "deleted",
  errorCode: string | null = null,
) {
  if (w.lastRunId)
    await db
      .update(minkWorkflowRuns)
      .set({ cancelRequestedAt: new Date().toISOString() })
      .where(
        and(
          eq(minkWorkflowRuns.id, w.lastRunId),
          eq(minkWorkflowRuns.storeId, w.storeId),
          eq(minkWorkflowRuns.watchId, w.id),
        ),
      );
  await db
    .update(minkWatches)
    .set({
      status,
      version: w.version + 1,
      pendingRunId: null,
      errorCode,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(minkWatches.id, w.id));
  await audit(db, w, errorCode ?? status, w.version + 1);
}

export async function listMinkWatches(
  actor: MinkActorContext,
  includeResults = true,
) {
  const watches = await withService((db) =>
    db
      .select()
      .from(minkWatches)
      .where(and(owner(actor), ne(minkWatches.status, "deleted")))
      .orderBy(asc(minkWatches.createdAt))
      .limit(5),
  );
  const views: WatchView[] = [];
  for (const w of watches) {
    const allowed = await authorized(w);
    const run =
      allowed && includeResults && w.processedRunId
        ? await withService((db) =>
            db
              .select({
                result: minkWorkflowRuns.resultJson,
                status: minkWorkflowRuns.status,
              })
              .from(minkWorkflowRuns)
              .where(
                and(
                  eq(minkWorkflowRuns.id, w.processedRunId!),
                  eq(minkWorkflowRuns.storeId, actor.storeId),
                  eq(minkWorkflowRuns.adminId, actor.adminId),
                  eq(minkWorkflowRuns.watchId, w.id),
                ),
              )
              .limit(1),
          )
        : [];
    const input = w.inputJson as BusinessBriefInput;
    views.push({
      id: w.id,
      kind: w.kind,
      status: w.status,
      version: w.version,
      schedule: readWatchSchedule(w.scheduleJson),
      timeZone: input.timeZone,
      locationLabel: allowed
        ? input.locationLabel
        : "Scope no longer accessible",
      nextRunAt: w.nextRunAt,
      lastAlertAt: w.lastAlertAt,
      errorCode: allowed ? w.errorCode : "authorization_revoked",
      result:
        run[0]?.status === "completed"
          ? (run[0].result as BusinessBriefResult)
          : null,
    });
  }
  // Resolve only current accessible choices; never return captured requester email or IDs.
  const scope = await resolveMinkLocation(actor, undefined);
  return {
    watches: views,
    locations: scope.availableLocations.map((l) => l.name),
    timeZone: actor.analyticsTimeZone,
  };
}

export async function createMinkWatch(
  actor: MinkActorContext,
  raw: Record<string, unknown>,
) {
  if (
    Object.keys(raw).some(
      (k) =>
        ![
          "action",
          "kind",
          "schedule",
          "locationName",
          "creationKey",
          "confirmed",
        ].includes(k),
    ) ||
    raw.confirmed !== true ||
    typeof raw.creationKey !== "string" ||
    !UUID.test(raw.creationKey) ||
    !WATCH_KINDS.includes(raw.kind as WatchKind) ||
    (raw.locationName !== undefined &&
      (typeof raw.locationName !== "string" || raw.locationName.length > 100))
  )
    fail("Review the watch and explicitly confirm before enabling it.");
  let schedule: WatchSchedule;
  try {
    schedule = readWatchSchedule(raw.schedule);
  } catch (e) {
    return fail((e as Error).message);
  }
  const input = await captureBusinessBriefInput(actor, {
    period: schedule.frequency,
    locationName: raw.locationName,
  });
  const nextRunAt = nextWatchTime(schedule, input.timeZone, new Date());
  return withService(async (db) => {
    // Serialize creations per store so both owner and tenant caps survive concurrent tabs.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mink-watch:${actor.storeId}`}, 0))`,
    );
    const duplicate = await db
      .select()
      .from(minkWatches)
      .where(
        and(
          owner(actor),
          eq(minkWatches.creationKey, raw.creationKey as string),
        ),
      )
      .limit(1);
    if (duplicate[0])
      return { id: duplicate[0].id, status: duplicate[0].status };
    const counts = await db
      .select({ adminId: minkWatches.adminId })
      .from(minkWatches)
      .where(
        and(
          eq(minkWatches.storeId, actor.storeId),
          ne(minkWatches.status, "deleted"),
        ),
      )
      .limit(20);
    if (
      counts.length >= 20 ||
      counts.filter((w) => w.adminId === actor.adminId).length >= 5
    )
      fail(
        "Limit reached: 5 watches per admin and 20 per store, including paused watches. Delete a watch first.",
        409,
      );
    const [w] = await db
      .insert(minkWatches)
      .values({
        storeId: actor.storeId,
        adminId: actor.adminId,
        creationKey: raw.creationKey as string,
        kind: raw.kind as WatchKind,
        scheduleJson: schedule,
        inputJson: input,
        nextRunAt,
      })
      .returning();
    await audit(db, w, "created");
    return { id: w.id, status: w.status };
  });
}

export async function changeMinkWatch(
  actor: MinkActorContext,
  raw: Record<string, unknown>,
) {
  if (
    Object.keys(raw).some((k) => !["action", "id", "version"].includes(k)) ||
    typeof raw.id !== "string" ||
    !UUID.test(raw.id) ||
    !["pause", "resume", "delete"].includes(raw.action as string) ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 1
  )
    fail("Choose a valid watch action and version.");
  return withService(async (db) => {
    const [w] = await db
      .select()
      .from(minkWatches)
      .where(and(owner(actor), eq(minkWatches.id, raw.id as string)))
      .limit(1)
      .for("update");
    if (!w || w.status === "deleted") fail("Watch not found.", 404);
    if (w.version !== raw.version)
      fail("This watch changed. Refresh before trying again.", 409);
    if (raw.action === "resume") {
      if (w.status !== "paused") fail("Only a paused watch can resume.", 409);
      if (!(await authorized(w, db)))
        fail(
          "Watch permissions or its captured location scope are no longer available. Recreate it with your current scope.",
          403,
        );
      const input = w.inputJson as BusinessBriefInput;
      await db
        .update(minkWatches)
        .set({
          status: "active",
          version: w.version + 1,
          lastRunId: null,
          pendingRunId: null,
          errorCode: null,
          nextRunAt: nextWatchTime(
            readWatchSchedule(w.scheduleJson),
            input.timeZone,
            new Date(),
          ),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(minkWatches.id, w.id));
      await audit(db, w, "resumed", w.version + 1);
    } else await stop(db, w, raw.action === "delete" ? "deleted" : "paused");
    return { id: w.id };
  });
}

/** Existing minute heartbeat: five due watches at most, no catch-up burst, one in flight.
 * Lock watch before workflow consistently. Creation + steps + next schedule commit together. */
export async function scheduleMinkWatches(now = new Date()) {
  if (!getMinkConfig().enabled) return 0;
  return withService(async (db) => {
    const due = await db
      .select()
      .from(minkWatches)
      .where(
        and(
          eq(minkWatches.status, "active"),
          sql`${minkWatches.nextRunAt} <= ${now.toISOString()}::timestamptz`,
          sql`(${minkWatches.lastRunId} IS NULL OR ${minkWatches.lastRunId} = ${minkWatches.processedRunId})`,
          sql`NOT EXISTS (SELECT 1 FROM ${minkWorkflowRuns} WHERE ${minkWorkflowRuns.watchId} = ${minkWatches.id} AND ${minkWorkflowRuns.storeId} = ${minkWatches.storeId} AND ${minkWorkflowRuns.status} IN ('queued', 'running'))`,
        ),
      )
      .orderBy(asc(minkWatches.nextRunAt))
      .limit(5)
      .for("update", { skipLocked: true });
    let queued = 0;
    for (const w of due) {
      if (!(await authorized(w, db))) {
        await stop(db, w, "paused", "authorization_revoked");
        continue;
      }
      const input = w.inputJson as BusinessBriefInput;
      const schedule = readWatchSchedule(w.scheduleJson);
      // Wait for reconciliation, even on failure, before replacing the latest run.
      if (w.lastRunId && w.lastRunId !== w.processedRunId) continue;
      const [run] = await db
        .insert(minkWorkflowRuns)
        .values({
          storeId: w.storeId,
          adminId: w.adminId,
          watchId: w.id,
          template: "business_brief",
          idempotencyKey: `watch:${w.id}:${w.version}:${new Date(w.nextRunAt).toISOString()}`,
          inputJson: { ...input, requestedAt: now.toISOString() },
          totalSteps: 3,
        })
        .returning();
      await db.insert(minkWorkflowSteps).values(
        ["snapshot", "analyse", "finalise"].map((stepKey, position) => ({
          runId: run.id,
          storeId: w.storeId,
          stepKey,
          position,
          inputJson: {},
        })),
      );
      await db
        .update(minkWatches)
        .set({
          lastRunId: run.id,
          nextRunAt: nextWatchTime(schedule, input.timeZone, now, w.nextRunAt),
          updatedAt: now.toISOString(),
        })
        .where(eq(minkWatches.id, w.id));
      await audit(db, w, "scheduled");
      queued++;
    }
    return queued;
  });
}

/** Durable outbox. Generic notification contains no metrics; owner-only readback revalidates.
 * Holding the watch lock linearizes delivery against pause/delete. Notification fan-out
 * and acknowledgement share this transaction; the unique subject also makes retries safe. */
export async function reconcileMinkWatches(now = new Date()) {
  if (!getMinkConfig().enabled) return 0;
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkWatches)
      .where(
        and(
          eq(minkWatches.status, "active"),
          sql`(${minkWatches.pendingRunId} IS NOT NULL OR (${minkWatches.lastRunId} IS NOT NULL AND ${minkWatches.lastRunId} IS DISTINCT FROM ${minkWatches.processedRunId}))`,
        ),
      )
      .orderBy(asc(minkWatches.updatedAt))
      .limit(10)
      .for("update", { skipLocked: true });
    let delivered = 0;
    for (const original of rows) {
      const w = { ...original };
      if (!(await authorized(w, db))) {
        await stop(db, w, "paused", "authorization_revoked");
        continue;
      }
      if (w.lastRunId && w.lastRunId !== w.processedRunId) {
        const [run] = await db
          .select()
          .from(minkWorkflowRuns)
          .where(
            and(
              eq(minkWorkflowRuns.id, w.lastRunId),
              eq(minkWorkflowRuns.watchId, w.id),
              eq(minkWorkflowRuns.storeId, w.storeId),
            ),
          )
          .limit(1);
        if (run && ["failed", "cancelled"].includes(run.status)) {
          await stop(db, w, "paused", "check_failed");
          continue;
        }
        if (run?.status === "completed") {
          const result = run.resultJson as BusinessBriefResult;
          const unknown =
            w.kind !== "brief" &&
            result.signals.find((s) => s.key === w.kind)?.status ===
              "insufficient_data";
          const fingerprint = watchFingerprint(w.kind as WatchKind, result);
          w.pendingRunId =
            fingerprint === null
              ? null
              : fingerprint !== w.fingerprint
                ? run.id
                : w.pendingRunId;
          if (!unknown) w.fingerprint = fingerprint;
          w.processedRunId = run.id;
        }
      }
      const input = w.inputJson as BusinessBriefInput;
      if (
        w.pendingRunId &&
        !inWatchQuietHours(
          readWatchSchedule(w.scheduleJson),
          input.timeZone,
          now,
        )
      ) {
        const eventId = await recordEvent(
          {
            type: "mink.watch_ready",
            storeId: w.storeId,
            actor: { type: "system", label: "Mink AI" },
            subject: { type: "mink_watch", id: w.pendingRunId },
            payload: { url: "/dashboard/mink-watches" },
            restrictToAdminIds: [w.adminId],
            deduplicate: true,
          },
          db,
        );
        const exists = eventId
          ? true
          : (
              await db
                .select({ id: activityEvents.id })
                .from(activityEvents)
                .where(
                  and(
                    eq(activityEvents.storeId, w.storeId),
                    eq(activityEvents.type, "mink.watch_ready"),
                    eq(activityEvents.subjectId, w.pendingRunId),
                  ),
                )
                .limit(1)
            ).length > 0;
        if (exists) {
          w.pendingRunId = null;
          w.lastAlertAt = now.toISOString();
          delivered++;
        }
      }
      await db
        .update(minkWatches)
        .set({
          processedRunId: w.processedRunId,
          pendingRunId: w.pendingRunId,
          fingerprint: w.fingerprint,
          lastAlertAt: w.lastAlertAt,
          updatedAt: now.toISOString(),
        })
        .where(eq(minkWatches.id, w.id));
    }
    // Bounded retention: old scheduled snapshots, never manual briefs/current pointers.
    await db.execute(sql`DELETE FROM public.mink_workflow_runs WHERE id IN (
      SELECT r.id FROM public.mink_workflow_runs r JOIN public.mink_watches w ON w.id = r.watch_id AND w.store_id = r.store_id
      WHERE r.status IN ('completed','failed','cancelled') AND r.created_at < now() - interval '30 days'
        AND r.id IS DISTINCT FROM w.last_run_id AND r.id IS DISTINCT FROM w.processed_run_id AND r.id IS DISTINCT FROM w.pending_run_id
      ORDER BY r.created_at LIMIT 50
    )`);
    await db.execute(
      sql`DELETE FROM public.mink_watches WHERE id IN (SELECT id FROM public.mink_watches WHERE status = 'deleted' AND updated_at < now() - interval '30 days' ORDER BY updated_at LIMIT 20)`,
    );
    return delivered;
  });
}
