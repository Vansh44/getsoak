// ---------------------------------------------------------------------------
// Log retention — the sweep that deletes rows past their window.
//
// ── Why this file exists ──────────────────────────────────────────────────
// Three tables grow forever and nothing ever pruned them. `email_logs.sql`
// documented a 90-day intent and even carries an `email_logs_created_idx`
// built "for retention sweeps"; `pruneNotifications` was written with correct
// windows and a docstring claiming it was "called by the daily cron". Nothing
// called it — grep returned the definition and nothing else. So the retention
// policy existed in three places as prose and in none as behaviour.
//
// ── ★ WHY THE CORE IS HERE AND NOT IN `app/actions/` ──────────────────────
// It used to live in `app/actions/notification-actions.ts`, a `"use server"`
// file — where EVERY export is a publicly reachable endpoint. `pruneNotifications`
// had no gate of any kind, ran under `withService` (which BYPASSES RLS), and took
// its retention windows as PARAMETERS. An unauthenticated caller passing zeroes
// would have deleted every notification, every email log, and the whole of
// `activity_events` — the append-only audit trail — across every store on the
// platform. Destroying the audit log is what an attacker does to cover their
// tracks, and this was the one endpoint that did it in a single call.
// This is the identical hazard CODEBASE.md §30 describes for
// `lib/domains/reconcile.ts`, and it gets the identical answer: the core lives
// in `lib/`, the route is the gate. Do not move it back.
//
// ── ★ EACH BATCH IS ITS OWN TRANSACTION ───────────────────────────────────
// `withService` wraps its callback in one BEGIN/COMMIT, so looping batches
// INSIDE a single call would be one enormous transaction — exactly what
// batching exists to avoid. The loop therefore calls `withService` per batch:
// locks are released between batches, WAL stays bounded, and a run that dies
// half way leaves the committed batches deleted. The sweep is idempotent and
// resumable, so the next night simply carries on.
// ---------------------------------------------------------------------------

import { inArray, lt } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { activityEvents, emailLogs, notifications } from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";

/** Rows deleted per statement. Bounds both the IN list and the lock window. */
export const BATCH_SIZE = 1000;

/**
 * Most rows one table may shed in a single run. A first sweep over a table
 * that has never been pruned could otherwise run for the whole attempt
 * deadline; the leftovers are picked up tomorrow.
 */
export const MAX_ROWS_PER_TABLE = 50_000;

/**
 * Wall-clock budget. Cloud Scheduler's attempt deadline is 300s, so stopping
 * cleanly at 240 leaves the route time to report what it did. Being killed
 * mid-sweep is survivable (each batch is committed) but reports nothing, and a
 * job that reports nothing is one nobody can tell is working.
 */
export const TIME_BUDGET_MS = 240_000;

/** Why a sweep stopped — reported per table so a short run is explicable. */
export type SweepStop = "drained" | "cap" | "budget" | "error";

export interface RetentionPolicy {
  /** Table name, as it appears in the cron response and the logs. */
  table: string;
  /** How long a row lives. */
  days: number;
  /** Why this window. Kept beside the number so the two cannot drift. */
  reason: string;
  /** Deletes up to `limit` rows older than `floorIso`; returns how many went. */
  deleteBatch: (floorIso: string, limit: number) => Promise<number>;
}

export interface SweepResult {
  table: string;
  days: number;
  deleted: number;
  stop: SweepStop;
  /** Present only when `stop` is "error". */
  error?: string;
}

/** The instant a row of this age would have been created. */
export function retentionFloor(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * Deletes in bounded batches, each its own transaction (see the header).
 *
 * `deleteBatch` is injected so the loop — the part with the stopping rules —
 * is testable without a database.
 */
export async function sweepPolicy(
  policy: RetentionPolicy,
  opts: {
    now?: Date;
    batchSize?: number;
    maxRows?: number;
    deadline?: number;
    clock?: () => number;
  } = {},
): Promise<SweepResult> {
  const {
    now = new Date(),
    batchSize = BATCH_SIZE,
    maxRows = MAX_ROWS_PER_TABLE,
    clock = Date.now,
    deadline = clock() + TIME_BUDGET_MS,
  } = opts;

  const floor = retentionFloor(policy.days, now);
  let deleted = 0;

  for (;;) {
    if (deleted >= maxRows) {
      return { table: policy.table, days: policy.days, deleted, stop: "cap" };
    }
    if (clock() >= deadline) {
      return {
        table: policy.table,
        days: policy.days,
        deleted,
        stop: "budget",
      };
    }

    // Never overshoot the cap on the final batch.
    const limit = Math.min(batchSize, maxRows - deleted);

    let removed: number;
    try {
      removed = await policy.deleteBatch(floor, limit);
    } catch (error) {
      // One table's failure must not abandon the others — the caller keeps
      // going and the route reports this table as failed.
      logError(`retention: ${policy.table} batch failed`, error);
      return {
        table: policy.table,
        days: policy.days,
        deleted,
        stop: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    deleted += removed;

    // A short batch means the table is drained: the floor only moves backwards
    // in time, so nothing new can fall behind it mid-run.
    if (removed < limit) {
      return {
        table: policy.table,
        days: policy.days,
        deleted,
        stop: "drained",
      };
    }
  }
}

/**
 * Deletes one bounded batch of rows older than the floor, in a single
 * transaction. Two statements rather than a DELETE ... IN (subquery) so the
 * intent stays legible; they are atomic together inside `withService`.
 */
function batchDeleter(
  table: typeof notifications | typeof activityEvents | typeof emailLogs,
): (floorIso: string, limit: number) => Promise<number> {
  return (floorIso, limit) =>
    withService(async (db) => {
      const doomed = await db
        .select({ id: table.id })
        .from(table)
        .where(lt(table.createdAt, floorIso))
        .limit(limit);
      if (doomed.length === 0) return 0;
      await db.delete(table).where(
        inArray(
          table.id,
          doomed.map((row) => row.id),
        ),
      );
      return doomed.length;
    });
}

/**
 * ── ORDER IS LOAD-BEARING ─────────────────────────────────────────────────
 * `notifications.event_id` references `activity_events` ON DELETE CASCADE, so
 * pruning events also destroys their notifications. Notifications go FIRST
 * (and at the shorter window), which leaves the event sweep far less to
 * cascade through. It also means the notification count below undercounts:
 * rows cascaded away by the event sweep are not attributed to it. That is
 * cosmetic — an event old enough to be pruned at 365 days carries only
 * notifications that were themselves already pruned at 90.
 *
 * ⚠ To add a table, add an entry. `data_jobs` / `data_job_issues` belong here
 * and are NOT yet included — they live on the unmerged import/export work and
 * do not exist in this branch's schema. See docs/cron-jobs.md.
 */
export const RETENTION_POLICIES: RetentionPolicy[] = [
  {
    table: "notifications",
    days: 90,
    reason:
      "A read inbox row is history. 90 days outlives any 'what did I miss?' question.",
    deleteBatch: batchDeleter(notifications),
  },
  {
    table: "activity_events",
    days: 365,
    reason:
      "The audit trail, so it gets the longest life — a year covers 'who changed this?' " +
      "long after the fact. Financial records (orders, refunds, credit notes) live in " +
      "their own tables and are NOT touched by this.",
    deleteBatch: batchDeleter(activityEvents),
  },
  {
    table: "email_logs",
    days: 90,
    reason:
      "Holds rendered BODIES, so it is the heaviest of the three and gets the shortest " +
      "life. 90 days still answers 'did last quarter's order confirmation go out?'.",
    deleteBatch: batchDeleter(emailLogs),
  },
];

export interface RetentionSweep {
  results: SweepResult[];
  deleted: number;
  /** True when any table failed — the route turns this into a 503. */
  failed: boolean;
  /** True when a table stopped on its cap or the clock, not because it drained. */
  incomplete: boolean;
}

/** Runs every policy. One table's failure never stops the next. */
export async function runRetentionSweep(
  policies: RetentionPolicy[] = RETENTION_POLICIES,
  opts: Parameters<typeof sweepPolicy>[1] = {},
): Promise<RetentionSweep> {
  // One deadline for the whole run, so the tables share the budget rather than
  // each being handed a fresh one.
  const clock = opts.clock ?? Date.now;
  const deadline = opts.deadline ?? clock() + TIME_BUDGET_MS;

  const results: SweepResult[] = [];
  for (const policy of policies) {
    results.push(await sweepPolicy(policy, { ...opts, clock, deadline }));
  }

  const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
  const failed = results.some((r) => r.stop === "error");
  const incomplete = results.some(
    (r) => r.stop === "cap" || r.stop === "budget",
  );

  if (failed) {
    // The individual batch failure is already logged with its error at the
    // point it happened; this is the run-level line to alert on.
    logError("retention: sweep had failures", undefined, { results });
  } else if (incomplete) {
    // Not an error — a backlog drains over consecutive nights — but it should
    // be visible, because "still incomplete" every night means it never drains.
    logWarn("retention: sweep incomplete", { results });
  } else if (deleted > 0) {
    logInfo("retention: sweep complete", { deleted, results });
  }

  return { results, deleted, failed, incomplete };
}
