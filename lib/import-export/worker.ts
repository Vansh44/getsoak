import "server-only";

// The server-side import worker — what makes an import a REAL background job.
//
// ★ WHY THIS EXISTS. The chunk loop used to run in the merchant's BROWSER: the
// file was parsed there and posted a slice at a time, so closing the tab left
// the import half-applied. That was a reasonable answer to two hard limits — a
// server action's body cap and Cloud Run's request timeout — but it meant
// "start it and get on with your day" was never actually true.
//
// Now the file is uploaded once and stored (data_job_payloads), and this module
// applies it a time-boxed slice at a time, chaining itself until the file runs
// out. The browser's only job is the upload. Closing the tab changes nothing.
//
// ★ NOT A `"use server"` FILE, DELIBERATELY. Everything exported from one is a
// publicly reachable endpoint, and this bypasses RLS with `withService` and
// takes no user context at all — the exact shape of the ungated `prune` that
// could have wiped every store's audit trail (CODEBASE §32). The cron route is
// the gate; the work lives here.

import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { TAGS } from "@/lib/storefront/tags";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { dataJobPayloads, dataJobs } from "@/drizzle/schema";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { emitEvent } from "@/lib/notifications/record";
import { parseCsv, type CsvRow } from "@/lib/csv/parse";
import { crossRowIssues, groupProductRows, parseFile } from "./parse";
import { getResource } from "./resources";
import { addProgress, finishJob, getJob, recordIssues } from "./jobs";
import type { RowIssue } from "./types";
import { importCategories } from "./importers/categories";
import { importCoupons } from "./importers/coupons";
import { importInventory } from "./importers/inventory";
import { importProducts } from "./importers/products";
import type {
  ImportContext,
  ImportOptions,
  RowResult,
} from "./importers/types";

/**
 * How long a claim holds a job.
 *
 * Long enough to outlast one slice comfortably, short enough that a worker
 * killed mid-slice (a deploy, an OOM) frees the job within a couple of minutes
 * rather than stranding it until someone notices.
 */
export const LEASE_MS = 2 * 60 * 1000;

/**
 * Wall-clock budget for one run's row processing.
 *
 * The route declares `maxDuration = 60`, so this leaves headroom to finish the
 * row in flight, write progress and chain the next run. Time, not a row count,
 * because rows differ by an order of magnitude in cost — a product with
 * variants and images against a coupon.
 */
export const SLICE_BUDGET_MS = 40_000;

/**
 * Rows one run will take even if the budget hasn't run out.
 *
 * A ceiling on memory and on how much a single crash loses, and it keeps
 * `cursor` moving visibly so the job page's progress bar animates.
 */
export const SLICE_MAX_ROWS = 500;

/**
 * Claims before a job gives up.
 *
 * A job that dies the same way every time — a row that reliably crashes an
 * importer — must stop being re-claimed by every sweep forever. Five is enough
 * to ride out a deploy or two.
 */
export const MAX_ATTEMPTS = 5;

/** Rows this run should take, given where it is. Pure, so the bounds are
 *  testable without a database. */
export function sliceBounds(
  cursor: number,
  totalRows: number,
  maxRows = SLICE_MAX_ROWS,
): { from: number; to: number; done: boolean } {
  const from = Math.max(0, Math.min(cursor, totalRows));
  const to = Math.min(totalRows, from + Math.max(1, maxRows));
  return { from, to, done: from >= totalRows };
}

/** Has this run used its time? Pure for the same reason. */
export function budgetSpent(startedMs: number, nowMs: number): boolean {
  return nowMs - startedMs >= SLICE_BUDGET_MS;
}

export interface ClaimedJob {
  id: string;
  storeId: string;
  resource: string;
  filename: string | null;
  totalRows: number;
  cursor: number;
  attempts: number;
  options: Record<string, unknown>;
  createdBy: string | null;
  actorEmail: string | null;
}

/**
 * Take the oldest queued job whose lease is free.
 *
 * ★ THE CLAIM AND THE LEASE ARE ONE STATEMENT. This worker chains itself AND a
 * cron sweep picks up stalled jobs, so two runs can genuinely overlap — and
 * importing is not idempotent, so an overlap would apply a slice twice
 * (duplicate products, double stock). `FOR UPDATE SKIP LOCKED` plus a lease
 * written in the same statement means the loser claims nothing rather than
 * claiming the same work: the `increment_coupon_usage` pattern applied to a
 * queue.
 */
async function claimJob(): Promise<ClaimedJob | null> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();

  return withService(async (db) => {
    const rows = await db
      .select({ id: dataJobs.id })
      .from(dataJobs)
      .where(
        and(
          eq(dataJobs.kind, "import"),
          inArray(dataJobs.status, ["pending", "running"]),
          lt(dataJobs.attempts, MAX_ATTEMPTS),
          or(
            isNull(dataJobs.leaseUntil),
            lt(dataJobs.leaseUntil, now.toISOString()),
          ),
        ),
      )
      .orderBy(asc(dataJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    const id = rows[0]?.id;
    if (!id) return null;

    const [claimed] = await db
      .update(dataJobs)
      .set({
        status: "running",
        leaseUntil,
        attempts: sql`${dataJobs.attempts} + 1`,
        startedAt: sql`coalesce(${dataJobs.startedAt}, now())`,
      })
      .where(eq(dataJobs.id, id))
      .returning({
        id: dataJobs.id,
        storeId: dataJobs.storeId,
        resource: dataJobs.resource,
        filename: dataJobs.filename,
        totalRows: dataJobs.totalRows,
        cursor: dataJobs.cursor,
        attempts: dataJobs.attempts,
        options: dataJobs.options,
        createdBy: dataJobs.createdBy,
        actorEmail: dataJobs.actorEmail,
      });

    if (!claimed) return null;
    return {
      ...claimed,
      options: (claimed.options ?? {}) as Record<string, unknown>,
    };
  });
}

/** Hand the job back so the next run can pick it up immediately. */
async function releaseLease(jobId: string): Promise<void> {
  await withService((db) =>
    db.update(dataJobs).set({ leaseUntil: null }).where(eq(dataJobs.id, jobId)),
  );
}

async function readPayload(
  jobId: string,
): Promise<{ header: string[]; csv: string } | null> {
  const rows = await withService((db) =>
    db
      .select({ header: dataJobPayloads.header, csv: dataJobPayloads.csv })
      .from(dataJobPayloads)
      .where(eq(dataJobPayloads.jobId, jobId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;
  return {
    header: Array.isArray(row.header) ? (row.header as string[]) : [],
    csv: row.csv,
  };
}

/**
 * Drop the file once the job is finished.
 *
 * It is the merchant's raw data and has no further use — the row-by-row log is
 * what anyone comes back for. Deleting on completion means the common case
 * doesn't wait on the retention sweep to stop holding a 25 MB blob.
 */
async function dropPayload(jobId: string): Promise<void> {
  try {
    await withService((db) =>
      db.delete(dataJobPayloads).where(eq(dataJobPayloads.jobId, jobId)),
    );
  } catch (error) {
    // Housekeeping: retention (§32) will get it. Never fail a finished import.
    logWarn("import worker: could not drop payload", { jobId, error });
  }
}

function normalizeOptions(input: Record<string, unknown>): ImportOptions {
  return {
    create: input.create !== false,
    update: input.update !== false,
    locationId:
      typeof input.locationId === "string" && input.locationId
        ? input.locationId
        : null,
  };
}

/**
 * Apply one slice of rows.
 *
 * ★ ROW-ATOMIC, NOT SLICE-ATOMIC — unchanged from the version that ran in the
 * browser, and the reason `partial` is a real status. Each row is its own
 * transaction, so row 12 failing says nothing about row 13. Wrapping a slice in
 * one transaction would mean one bad cell discards 499 good rows, after which
 * the merchant — unable to tell which — re-uploads and duplicates everything
 * that did work.
 *
 * ★ AND IT RE-PARSES. The stored CSV is the merchant's bytes, so every
 * coercion, length cap, URL-scheme check and enum check runs here against the
 * registry. That was true of the browser-chunked version too; it stays true
 * now that nothing upstream has looked at the file at all.
 */
export async function applySlice(
  job: ClaimedJob,
  header: string[],
  rows: CsvRow[],
  firstSlice: boolean,
): Promise<{ failed: number }> {
  const resource = getResource(job.resource);
  if (!resource) throw new Error(`Unknown resource: ${job.resource}`);

  const parsed = parseFile(resource.id, {
    header,
    rows,
    delimiter: ",",
    raggedLines: [],
    truncated: false,
  });
  if ("error" in parsed) throw new Error(parsed.error);

  const ctx: ImportContext = {
    storeId: job.storeId,
    admin: { uid: job.createdBy ?? "", email: job.actorEmail ?? null },
    options: normalizeOptions(job.options),
  };

  // File-level issues describe the HEADER, so every slice re-derives the same
  // set. Recorded on the FIRST slice only: repeating them would bury the row
  // errors, and dropping them entirely loses the one note explaining why a
  // whole column appears to have been ignored.
  const issues: RowIssue[] = parsed.fileIssues.filter(
    (i) => i.line > 0 || firstSlice,
  );

  const badRows = parsed.records.filter((r) => !r.ok);
  for (const record of badRows) issues.push(...record.issues);
  const goodRows = parsed.records.filter((r) => r.ok);
  issues.push(...crossRowIssues(resource, goodRows));

  let results: RowResult[] = [];
  switch (resource.id) {
    case "products":
      results = await importProducts(ctx, groupProductRows(goodRows));
      break;
    case "categories":
      results = await importCategories(ctx, goodRows);
      break;
    case "inventory":
      results = await importInventory(ctx, goodRows);
      break;
    case "coupons":
      results = await importCoupons(ctx, goodRows);
      break;
    default:
      throw new Error(`${resource.label} can't be imported.`);
  }

  for (const result of results) issues.push(...result.issues);

  const created = results.filter((r) => r.outcome === "created").length;
  const updated = results.filter((r) => r.outcome === "updated").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const failed =
    badRows.length + results.filter((r) => r.outcome === "failed").length;

  const stored = await recordIssues(job.id, job.storeId, issues);
  await addProgress(job.id, job.storeId, {
    processed: rows.length,
    created,
    updated,
    skipped,
    failed,
    warnings: issues.filter((i) => i.severity === "warning").length,
    dropped: stored.dropped,
  });

  return { failed };
}

/** Finalise: derive the status, refresh what changed, tell the merchant, drop
 *  the file.
 *
 *  ★ THE CACHE BUSTING AND THE SEO HOOK LIVE HERE NOW. They were in
 *  `finishImport`, the action the browser called when its chunk loop ran out —
 *  so moving the loop server-side without moving these would have left every
 *  import writing rows that the storefront kept serving stale, and new products
 *  never reaching Google. Conservative on purpose: an import can touch products,
 *  categories, stock or coupons, and being over-broad here is far cheaper than a
 *  merchant refreshing a shop that still shows yesterday's prices. */
async function finalize(job: ClaimedJob): Promise<void> {
  await finishJob(job.id, job.storeId);
  const finished = await getJob(job.id, job.storeId);
  await dropPayload(job.id);

  revalidateTag(TAGS.products, "max");
  revalidateTag(TAGS.categories, "max");
  revalidatePath("/dashboard/products");
  revalidatePath("/dashboard/categories");
  revalidatePath("/dashboard/inventory");
  revalidatePath("/dashboard/marketing/coupons");
  revalidatePath("/shop");

  // New or newly-published products need to reach search engines, the same
  // hook the single-product editor calls.
  if (job.resource === "products" && (finished?.createdCount ?? 0) > 0) {
    await notifyStoreContentPublished({
      storeId: job.storeId,
      paths: ["/shop", "/"],
    }).catch(() => {});
  }

  const resource = getResource(job.resource);
  emitEvent({
    type: "data.imported",
    storeId: job.storeId,
    // The person who started it, not "system" — they are who the audit trail
    // should name, and they may be long gone from the page by now.
    actor: job.createdBy
      ? { type: "admin", id: job.createdBy, label: job.actorEmail }
      : { type: "system" },
    subject: {
      type: "product",
      id: job.id,
      label: resource?.label ?? job.resource,
    },
    payload: {
      resource: resource?.label ?? job.resource,
      created: finished?.createdCount ?? 0,
      updated: finished?.updatedCount ?? 0,
      skipped: finished?.skippedCount ?? 0,
      failed: finished?.failedCount ?? 0,
      status: finished?.status ?? "completed",
      ...(job.filename ? { file: job.filename } : {}),
    },
  });
}

export interface WorkerResult {
  /** Jobs touched this run (0 or 1 — one job at a time, in order). */
  processed: number;
  /** Is there more to do? The route chains itself when true. */
  remaining: boolean;
  jobId?: string;
  status?: "advanced" | "finished" | "failed" | "idle";
}

/**
 * One worker run: claim a job, apply what fits in the budget, and say whether
 * more remains.
 *
 * Returns rather than throws — the route answers 200 either way, because a
 * failed import is a recorded outcome on the job, not an outage.
 */
export async function runImportWorker(
  nowMs: number = Date.now(),
): Promise<WorkerResult> {
  const job = await claimJob();
  if (!job) return { processed: 0, remaining: false, status: "idle" };

  try {
    if (job.attempts > MAX_ATTEMPTS) {
      await finishJob(job.id, job.storeId, {
        status: "failed",
        error: "Gave up after repeated failures.",
      });
      await dropPayload(job.id);
      return { processed: 1, remaining: true, jobId: job.id, status: "failed" };
    }

    const payload = await readPayload(job.id);
    if (!payload) {
      // The file is gone but the job says it has work left: unrecoverable, and
      // silence here would leave it re-claimed forever.
      await finishJob(job.id, job.storeId, {
        status: "failed",
        error: "The uploaded file is no longer available.",
      });
      return { processed: 1, remaining: true, jobId: job.id, status: "failed" };
    }

    // Re-parsed per run rather than cached: a worker run is a fresh process,
    // and parsing a 25 MB CSV is milliseconds next to the row writes.
    const csv = parseCsv(payload.csv);
    const total = csv.rows.length;

    let cursor = job.cursor;
    let firstSlice = cursor === 0;

    while (cursor < total && !budgetSpent(nowMs, Date.now())) {
      const { from, to } = sliceBounds(cursor, total);
      const slice = csv.rows.slice(from, to);
      if (slice.length === 0) break;

      await applySlice(job, payload.header, slice, firstSlice);
      cursor = to;
      firstSlice = false;

      // Persist after EVERY slice, not at the end of the run: this is what the
      // job page's progress bar reads, and it is where a killed worker resumes.
      await withService((db) =>
        db.update(dataJobs).set({ cursor }).where(eq(dataJobs.id, job.id)),
      );
    }

    if (cursor >= total) {
      await finalize(job);
      logInfo("import worker: finished", { jobId: job.id, rows: total });
      return {
        processed: 1,
        remaining: true,
        jobId: job.id,
        status: "finished",
      };
    }

    // More to do. Hand the lease back so the chained run starts at once rather
    // than waiting it out.
    await releaseLease(job.id);
    return { processed: 1, remaining: true, jobId: job.id, status: "advanced" };
  } catch (error) {
    logError("import worker: run threw", error, {
      jobId: job.id,
      resource: job.resource,
    });
    // Leave the job claimable: the lease lapses and another run resumes from
    // the cursor, which is why progress is written per slice. `attempts` is
    // what stops that becoming a loop.
    await releaseLease(job.id).catch(() => {});
    return { processed: 1, remaining: true, jobId: job.id, status: "failed" };
  }
}
