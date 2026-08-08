import "server-only";

// Job + error-log persistence for CSV import/export.
//
// Every write here is service-scope: `data_jobs` and `data_job_issues` have RLS
// ON with no policies (the email_logs pattern), because the issue rows quote
// raw cells from the merchant's file — for an orders export, customer names and
// addresses. Authorisation is the CALLER's job, and every caller in
// app/actions/import-export-actions.ts gates before it gets here.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dataJobIssues, dataJobs } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import type {
  ImportCounts,
  JobKind,
  JobStatus,
  ResourceId,
  RowIssue,
} from "./types";

/**
 * How many issue rows one job may write.
 *
 * A merchant who exports from the wrong platform and uploads 40,000 rows with
 * a mismatched header produces 40,000 identical errors. Storing them costs a
 * table scan on every history page and tells the merchant nothing the first
 * twenty didn't. The overflow is COUNTED on the job (`dropped_issues`) rather
 * than discarded silently — a log that looks complete when it isn't is worse
 * than a truncated one that says so.
 */
export const ISSUE_CAP = 1000;

/** Longest cell value kept in the log. Whole product descriptions otherwise. */
const VALUE_CAP = 300;
const MESSAGE_CAP = 1000;

export interface JobActor {
  uid: string;
  email: string | null;
}

export interface CreateJobInput {
  storeId: string;
  kind: JobKind;
  resource: ResourceId;
  filename?: string | null;
  totalRows?: number;
  options?: Record<string, unknown>;
  actor: JobActor;
  status?: JobStatus;
}

export async function createJob(input: CreateJobInput): Promise<string> {
  const [row] = await withService((db) =>
    db
      .insert(dataJobs)
      .values({
        storeId: input.storeId,
        kind: input.kind,
        resource: input.resource,
        status: input.status ?? "running",
        filename: input.filename?.slice(0, 300) ?? null,
        totalRows: input.totalRows ?? 0,
        options: input.options ?? {},
        createdBy: input.actor.uid,
        actorEmail: input.actor.email,
        startedAt: new Date().toISOString(),
      })
      .returning({ id: dataJobs.id }),
  );
  return row.id;
}

/**
 * Append issues to a job's log, respecting the cap.
 *
 * Best-effort by design: this is a LOG. A failure to record why row 12 was
 * rejected must not turn a 499-row success into an error the merchant sees —
 * they would re-upload and duplicate everything. It returns the number stored
 * so the caller can keep its own counters honest.
 */
export async function recordIssues(
  jobId: string,
  storeId: string,
  issues: readonly RowIssue[],
): Promise<{ stored: number; dropped: number }> {
  if (issues.length === 0) return { stored: 0, dropped: 0 };

  try {
    return await withService(async (db) => {
      const [existing] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(dataJobIssues)
        .where(eq(dataJobIssues.jobId, jobId));

      const already = existing?.n ?? 0;
      const room = Math.max(0, ISSUE_CAP - already);
      if (room === 0) return { stored: 0, dropped: issues.length };

      const keep = issues.slice(0, room);
      await db.insert(dataJobIssues).values(
        keep.map((issue) => ({
          jobId,
          storeId,
          line: issue.line,
          columnName: issue.column,
          code: issue.code,
          severity: issue.severity,
          message: issue.message.slice(0, MESSAGE_CAP),
          value: issue.value ? issue.value.slice(0, VALUE_CAP) : null,
        })),
      );
      return { stored: keep.length, dropped: issues.length - keep.length };
    });
  } catch (error) {
    logError("import/export: failed to record issues", error, { jobId });
    return { stored: 0, dropped: issues.length };
  }
}

export interface ProgressDelta {
  processed?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  warnings?: number;
  dropped?: number;
}

/**
 * Add to a job's counters.
 *
 * INCREMENTS in SQL rather than read-modify-write: chunks arrive as separate
 * requests, and a double-submitted or retried chunk racing its predecessor
 * would otherwise clobber a count with a stale total.
 */
export async function addProgress(
  jobId: string,
  storeId: string,
  delta: ProgressDelta,
): Promise<void> {
  const bump = (col: unknown, n?: number) =>
    n ? sql`${col} + ${n}` : undefined;

  const patch: Record<string, unknown> = {};
  const processed = bump(dataJobs.processedRows, delta.processed);
  if (processed) patch.processedRows = processed;
  const created = bump(dataJobs.createdCount, delta.created);
  if (created) patch.createdCount = created;
  const updated = bump(dataJobs.updatedCount, delta.updated);
  if (updated) patch.updatedCount = updated;
  const skipped = bump(dataJobs.skippedCount, delta.skipped);
  if (skipped) patch.skippedCount = skipped;
  const failed = bump(dataJobs.failedCount, delta.failed);
  if (failed) patch.failedCount = failed;
  const warnings = bump(dataJobs.warningCount, delta.warnings);
  if (warnings) patch.warningCount = warnings;
  const dropped = bump(dataJobs.droppedIssues, delta.dropped);
  if (dropped) patch.droppedIssues = dropped;

  if (Object.keys(patch).length === 0) return;

  await withService((db) =>
    db
      .update(dataJobs)
      .set(patch)
      .where(and(eq(dataJobs.id, jobId), eq(dataJobs.storeId, storeId))),
  );
}

/**
 * Close a job.
 *
 * `partial` is derived, not asked for: a run that created 497 rows and failed 3
 * is neither a success nor a failure, and calling it either one misleads. The
 * caller only says whether the whole run died.
 */
export async function finishJob(
  jobId: string,
  storeId: string,
  outcome: { status?: JobStatus; error?: string | null } = {},
): Promise<void> {
  await withService(async (db) => {
    let status = outcome.status;
    if (!status) {
      const [row] = await db
        .select({
          failed: dataJobs.failedCount,
          created: dataJobs.createdCount,
          updated: dataJobs.updatedCount,
        })
        .from(dataJobs)
        .where(and(eq(dataJobs.id, jobId), eq(dataJobs.storeId, storeId)));

      const failed = row?.failed ?? 0;
      const succeeded = (row?.created ?? 0) + (row?.updated ?? 0);
      status =
        failed === 0 ? "completed" : succeeded === 0 ? "failed" : "partial";
    }

    await db
      .update(dataJobs)
      .set({
        status,
        error: outcome.error?.slice(0, MESSAGE_CAP) ?? null,
        finishedAt: new Date().toISOString(),
      })
      .where(and(eq(dataJobs.id, jobId), eq(dataJobs.storeId, storeId)));
  });
}

export interface JobRow {
  id: string;
  kind: JobKind;
  resource: string;
  status: JobStatus;
  filename: string | null;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  warningCount: number;
  droppedIssues: number;
  error: string | null;
  options: Record<string, unknown>;
  actorEmail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

const JOB_COLUMNS = {
  id: dataJobs.id,
  kind: dataJobs.kind,
  resource: dataJobs.resource,
  status: dataJobs.status,
  filename: dataJobs.filename,
  totalRows: dataJobs.totalRows,
  processedRows: dataJobs.processedRows,
  createdCount: dataJobs.createdCount,
  updatedCount: dataJobs.updatedCount,
  skippedCount: dataJobs.skippedCount,
  failedCount: dataJobs.failedCount,
  warningCount: dataJobs.warningCount,
  droppedIssues: dataJobs.droppedIssues,
  error: dataJobs.error,
  options: dataJobs.options,
  actorEmail: dataJobs.actorEmail,
  startedAt: dataJobs.startedAt,
  finishedAt: dataJobs.finishedAt,
  createdAt: dataJobs.createdAt,
};

export interface ListJobsOptions {
  kind?: JobKind;
  resource?: ResourceId;
  status?: JobStatus;
  page?: number;
  pageSize?: number;
}

export async function listJobs(
  storeId: string,
  options: ListJobsOptions = {},
): Promise<{ rows: JobRow[]; total: number }> {
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));
  const page = Math.max(1, options.page ?? 1);

  const conds = [eq(dataJobs.storeId, storeId)];
  if (options.kind) conds.push(eq(dataJobs.kind, options.kind));
  if (options.resource) conds.push(eq(dataJobs.resource, options.resource));
  if (options.status) conds.push(eq(dataJobs.status, options.status));

  return withService(async (db) => {
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dataJobs)
      .where(and(...conds));

    const rows = await db
      .select(JOB_COLUMNS)
      .from(dataJobs)
      .where(and(...conds))
      .orderBy(desc(dataJobs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { rows: rows as JobRow[], total: count?.n ?? 0 };
  });
}

/** One job, scoped to the store — a job id from another store returns null. */
export async function getJob(
  jobId: string,
  storeId: string,
): Promise<JobRow | null> {
  const rows = await withService((db) =>
    db
      .select(JOB_COLUMNS)
      .from(dataJobs)
      .where(and(eq(dataJobs.id, jobId), eq(dataJobs.storeId, storeId)))
      .limit(1),
  );
  return (rows[0] as JobRow | undefined) ?? null;
}

export interface JobIssueRow {
  id: string;
  line: number;
  columnName: string | null;
  code: string;
  severity: "error" | "warning";
  message: string;
  value: string | null;
}

export async function getJobIssues(
  jobId: string,
  storeId: string,
  options: { severity?: "error" | "warning"; limit?: number } = {},
): Promise<JobIssueRow[]> {
  const limit = Math.min(ISSUE_CAP, Math.max(1, options.limit ?? ISSUE_CAP));
  const conds = [
    eq(dataJobIssues.jobId, jobId),
    eq(dataJobIssues.storeId, storeId),
  ];
  if (options.severity)
    conds.push(eq(dataJobIssues.severity, options.severity));

  const rows = await withService((db) =>
    db
      .select({
        id: dataJobIssues.id,
        line: dataJobIssues.line,
        columnName: dataJobIssues.columnName,
        code: dataJobIssues.code,
        severity: dataJobIssues.severity,
        message: dataJobIssues.message,
        value: dataJobIssues.value,
      })
      .from(dataJobIssues)
      .where(and(...conds))
      // Errors first — the reason anyone opens this page — then file order.
      .orderBy(asc(dataJobIssues.severity), asc(dataJobIssues.line))
      .limit(limit),
  );
  return rows as JobIssueRow[];
}

/**
 * Close jobs that were left running.
 *
 * A merchant who closes the tab mid-import leaves a `running` row that would
 * otherwise sit in their history forever looking like work still in progress.
 * Called opportunistically when the history page loads, so it needs no cron.
 */
export async function reapStaleJobs(
  storeId: string,
  olderThanMinutes = 30,
): Promise<void> {
  try {
    const cutoff = new Date(
      Date.now() - olderThanMinutes * 60_000,
    ).toISOString();
    await withService((db) =>
      db
        .update(dataJobs)
        .set({
          status: "cancelled",
          error: "Stopped before it finished — the tab was probably closed.",
          finishedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(dataJobs.storeId, storeId),
            inArray(dataJobs.status, ["pending", "running"]),
            sql`${dataJobs.updatedAt} < ${cutoff}`,
          ),
        ),
    );
  } catch (error) {
    // Housekeeping. It must never stop the history page rendering.
    logError("import/export: failed to reap stale jobs", error, { storeId });
  }
}

/** Aggregate counts for the job, for the summary line. */
export function jobCounts(job: JobRow): ImportCounts {
  return {
    total: job.totalRows,
    created: job.createdCount,
    updated: job.updatedCount,
    skipped: job.skippedCount,
    failed: job.failedCount,
  };
}
