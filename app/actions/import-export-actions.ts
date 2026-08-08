"use server";

// CSV import — the trust boundary (CODEBASE.md §31).
//
// Shaped like `placeOrder` and `placePosSale`: the caller is gated first,
// everything from the browser is re-validated server-side, and the write is
// last. The browser parses the file to build a preview, but that preview is a
// COURTESY — nothing it computed is trusted here. The same pure modules run
// again on the same bytes before a single row is written.
//
// ★ WHY IT IS CHUNKED. Two hard limits, one design:
//   • A Next.js server action has a request body cap, and a 20,000-row product
//     CSV is tens of megabytes.
//   • Cloud Run has a request timeout, and a long import will exceed it.
// Sending the file whole means both failures land on the merchant AFTER a long
// wait, with the import half-applied and no record of where it stopped. So the
// browser sends the rows in chunks against a job id, each chunk is a short
// request that commits what it did, and the job row is the memory between
// them. A dropped connection loses the REST of the file, not the part that
// already worked — and the job says exactly how far it got.

import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import {
  getActingStoreId,
  getManagerIdentity,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import { TAGS } from "@/lib/storefront/tags";
import { emitEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import type { CsvRow } from "@/lib/csv/parse";
import {
  crossRowIssues,
  groupProductRows,
  parseFile,
} from "@/lib/import-export/parse";
import { getResource, isResourceId } from "@/lib/import-export/resources";
// Limits live in lib/ because a "use server" file may only export async
// functions — everything exported from one is a public endpoint.
import { IMPORT_CHUNK_ROWS, MAX_IMPORT_ROWS } from "@/lib/import-export/limits";
import {
  addProgress,
  createJob,
  finishJob,
  getJob,
  getJobIssues,
  listJobs,
  reapStaleJobs,
  recordIssues,
  type JobIssueRow,
  type JobRow,
} from "@/lib/import-export/jobs";
import { importCategories } from "@/lib/import-export/importers/categories";
import { importCoupons } from "@/lib/import-export/importers/coupons";
import { importInventory } from "@/lib/import-export/importers/inventory";
import { importProducts } from "@/lib/import-export/importers/products";
import {
  DEFAULT_IMPORT_OPTIONS,
  type ImportContext,
  type ImportOptions,
  type RowResult,
} from "@/lib/import-export/importers/types";
import type { ResourceId, RowIssue } from "@/lib/import-export/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withUser } from "@/lib/db/client";
import { categories, coupons, products } from "@/drizzle/schema";
import { slugify } from "@/lib/slug";

export interface ActionResult<T = undefined> {
  success?: boolean;
  error?: string;
  data?: T;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * The caller may IMPORT this resource.
 *
 * Deliberately gated on the resource's OWN permission section rather than an
 * `import_export` permission of its own. A separate key would be a way to give
 * someone write access to the entire catalogue without giving them Products —
 * the grant would look narrow and be the widest one in the system.
 */
async function importGate(resourceId: string) {
  const resource = getResource(resourceId);
  if (!resource) return { error: "Unknown thing to import." as const };
  if (!resource.canImport)
    return { error: `${resource.label} can be exported but not imported.` };

  const admin = await getManagerIdentity(resource.section);
  if (!admin) return { error: "You don't have permission to import this." };

  // Inventory needs Products too — resolving a SKU is a product read and
  // writing a count is an inventory write. A role holding one but not the
  // other must not pass on the strength of the one.
  for (const extra of resource.alsoRequires ?? []) {
    if (!(await getManagerIdentity(extra)))
      return { error: "You don't have permission to import this." };
  }

  const storeId = await getActingStoreId();
  return { resource, admin, storeId };
}

function normalizeOptions(
  input: Partial<ImportOptions> | undefined,
): ImportOptions {
  return {
    create: input?.create ?? DEFAULT_IMPORT_OPTIONS.create,
    update: input?.update ?? DEFAULT_IMPORT_OPTIONS.update,
    locationId:
      typeof input?.locationId === "string" && input.locationId
        ? input.locationId
        : null,
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface ImportPreview {
  /** Match values that already exist here — everything else would be created. */
  existing: string[];
}

/**
 * Which of these match keys does the store already have?
 *
 * The browser already knows how many rows there are and what is malformed — it
 * ran the same parser. The one thing it CANNOT know is whether row 400 is a
 * new product or an edit to an existing one, and that is the number that
 * decides whether a merchant clicks Import. So the preview sends just the
 * match values (handles, codes, SKUs), never the file.
 */
export async function previewImport(
  resourceId: string,
  matchValues: string[],
): Promise<ActionResult<ImportPreview>> {
  const gate = await importGate(resourceId);
  if ("error" in gate) return { error: gate.error };
  const { resource, admin, storeId } = gate;

  const wanted = [
    ...new Set(
      (matchValues ?? [])
        .filter((v) => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, MAX_IMPORT_ROWS),
    ),
  ];
  if (wanted.length === 0) return { success: true, data: { existing: [] } };

  try {
    if (resource.id === "products") {
      const slugs = wanted.map((v) => slugify(v));
      const rows = await withUser(admin, (db) =>
        db
          .select({ slug: products.slug })
          .from(products)
          .where(
            and(eq(products.storeId, storeId), inArray(products.slug, slugs)),
          ),
      );
      return { success: true, data: { existing: rows.map((r) => r.slug) } };
    }

    if (resource.id === "categories") {
      const slugs = wanted.map((v) => slugify(v));
      const rows = await withUser(admin, (db) =>
        db
          .select({ slug: categories.slug })
          .from(categories)
          .where(
            and(
              eq(categories.storeId, storeId),
              inArray(categories.slug, slugs),
            ),
          ),
      );
      return { success: true, data: { existing: rows.map((r) => r.slug) } };
    }

    if (resource.id === "coupons") {
      const codes = wanted.map((v) => v.toUpperCase());
      const rows = await withUser(admin, (db) =>
        db
          .select({ code: coupons.code })
          .from(coupons)
          .where(
            and(
              eq(coupons.storeId, storeId),
              inArray(sql`upper(${coupons.code})`, codes),
            ),
          ),
      );
      return {
        success: true,
        data: { existing: rows.map((r) => r.code.toUpperCase()) },
      };
    }

    // Inventory only ever adjusts what exists, so "would this be created?"
    // isn't a question it has. The unknown-SKU errors surface at import.
    return { success: true, data: { existing: [] } };
  } catch (error) {
    logError("import: preview failed", error, { resource: resource.id });
    // A preview is an optimisation. Losing it must not stop the import.
    return { success: true, data: { existing: [] } };
  }
}

// ---------------------------------------------------------------------------
// The import
// ---------------------------------------------------------------------------

export interface StartImportInput {
  resource: string;
  filename?: string;
  totalRows: number;
  header: string[];
  options?: Partial<ImportOptions>;
}

export async function startImport(
  input: StartImportInput,
): Promise<ActionResult<{ jobId: string }>> {
  const gate = await importGate(input.resource);
  if ("error" in gate) return { error: gate.error };
  const { resource, admin, storeId } = gate;

  if (!Array.isArray(input.header) || input.header.length === 0)
    return { error: "That file has no header row." };
  if (input.totalRows > MAX_IMPORT_ROWS) {
    return {
      error: `That file has ${input.totalRows.toLocaleString("en-IN")} rows. Imports are limited to ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} at a time — split it and run them one after another.`,
    };
  }

  // Per-store, not per-user: the cost is database write throughput, and two
  // admins importing the whole catalogue at once is the same load as one doing
  // it twice. Generous, because a legitimate migration is several files.
  const limit = await rateLimit(`import:${storeId}`, {
    max: 20,
    windowSeconds: 3600,
  });
  if (!limit.allowed)
    return {
      error:
        "That's a lot of imports in one hour. Give it a few minutes and try again.",
    };

  const options = normalizeOptions(input.options);

  try {
    const jobId = await createJob({
      storeId,
      kind: "import",
      resource: resource.id,
      filename: input.filename ?? null,
      totalRows: input.totalRows,
      options: { ...options, header: input.header },
      actor: { uid: admin.uid, email: admin.email },
    });

    // ★ A SECOND EVENT FOR THE SAME IMPORT, DELIBERATELY. The rows are posted
    // in chunks by the browser while the merchant is free to navigate away, so
    // between here and `data.imported` there is a window — minutes, on a big
    // file — in which the only record of the import is a job row nobody has a
    // link to. This is that link. In-app only; see the registry entry.
    emitEvent({
      type: "data.import_started",
      storeId,
      actor: { type: "admin", id: admin.uid, label: admin.email },
      subject: { type: "product", id: jobId, label: resource.label },
      payload: {
        resource: resource.label,
        rows: input.totalRows,
        ...(input.filename ? { file: input.filename } : {}),
      },
    });

    return { success: true, data: { jobId } };
  } catch (error) {
    logError("import: could not start", error, { resource: resource.id });
    return { error: "Couldn't start the import. Please try again." };
  }
}

export interface ImportChunkInput {
  jobId: string;
  resource: string;
  header: string[];
  rows: CsvRow[];
  options?: Partial<ImportOptions>;
}

export interface ChunkSummary {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** A handful of issues, so the UI can show progress without a round trip. */
  sample: RowIssue[];
}

/**
 * Apply one chunk.
 *
 * ★ ROW-ATOMIC, NOT CHUNK-ATOMIC. Each row is its own transaction, so row 12
 * failing says nothing about row 13. Wrapping the chunk in one transaction
 * would be simpler and would mean one bad cell discards 199 good rows — and
 * the merchant, having no way to tell which, re-uploads and duplicates
 * everything that did work.
 */
export async function importChunk(
  input: ImportChunkInput,
): Promise<ActionResult<ChunkSummary>> {
  const gate = await importGate(input.resource);
  if ("error" in gate) return { error: gate.error };
  const { resource, admin, storeId } = gate;

  // The job id is scoped to the store, so a chunk cannot be posted into
  // another store's job even with a valid session here.
  const job = await getJob(input.jobId, storeId);
  if (!job) return { error: "That import can't be found." };
  if (job.kind !== "import" || job.resource !== resource.id)
    return { error: "That import is for something else." };
  if (job.status === "cancelled")
    return { error: "That import was cancelled." };

  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (rows.length === 0)
    return {
      success: true,
      data: { created: 0, updated: 0, skipped: 0, failed: 0, sample: [] },
    };
  if (rows.length > IMPORT_CHUNK_ROWS * 2)
    return { error: "That chunk is too large." };

  // ★ RE-PARSED SERVER-SIDE. The browser sent raw cells; every coercion,
  // length cap, URL scheme check and enum check runs again here against the
  // same registry. Trusting the browser's parse would make the whole
  // validation layer a suggestion.
  const parsed = parseFile(resource.id, {
    header: input.header ?? [],
    rows,
    delimiter: ",",
    raggedLines: [],
    truncated: false,
  });
  if ("error" in parsed) return { error: parsed.error };

  const ctx: ImportContext = {
    storeId,
    admin,
    options: normalizeOptions(input.options),
  };

  // File-level issues ("the Vendor column isn't one we recognise") describe the
  // HEADER, so every chunk re-derives the identical set. Recorded on the FIRST
  // chunk only — repeating them 100 times would bury the row errors, and
  // dropping them entirely (which is what filtering to `line > 0` did) loses
  // the one note that explains why a whole column appears to have been ignored.
  const firstChunk = job.processedRows === 0;
  const issues: RowIssue[] = parsed.fileIssues.filter(
    (i) => i.line > 0 || firstChunk,
  );
  let results: RowResult[] = [];

  // Rows that failed to PARSE never reach an importer — they are already
  // failures, with the cell-level reason the merchant needs.
  const badRows = parsed.records.filter((r) => !r.ok);
  for (const record of badRows) issues.push(...record.issues);
  const goodRows = parsed.records.filter((r) => r.ok);

  issues.push(...crossRowIssues(resource, goodRows));

  try {
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
        return { error: `${resource.label} can't be imported.` };
    }
  } catch (error) {
    // An importer is contractually not supposed to throw. If one does, the
    // chunk is lost but the JOB survives with the reason recorded — the
    // merchant sees where it stopped rather than a spinner that never ends.
    logError("import: chunk threw", error, {
      jobId: input.jobId,
      resource: resource.id,
    });
    await recordIssues(input.jobId, storeId, [
      {
        line: rows[0]?.line ?? 0,
        column: null,
        code: "chunk_failed",
        message: `Something went wrong applying rows ${rows[0]?.line}–${rows[rows.length - 1]?.line}. Nothing after this point in the chunk was imported.`,
        severity: "error",
        value: null,
      },
    ]);
    await addProgress(input.jobId, storeId, {
      processed: rows.length,
      failed: rows.length,
    });
    return { error: "Something went wrong importing those rows." };
  }

  for (const result of results) issues.push(...result.issues);

  const summary: ChunkSummary = {
    created: results.filter((r) => r.outcome === "created").length,
    updated: results.filter((r) => r.outcome === "updated").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    failed:
      badRows.length + results.filter((r) => r.outcome === "failed").length,
    sample: issues.slice(0, 5),
  };

  const stored = await recordIssues(input.jobId, storeId, issues);
  await addProgress(input.jobId, storeId, {
    processed: rows.length,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
    failed: summary.failed,
    warnings: issues.filter((i) => i.severity === "warning").length,
    dropped: stored.dropped,
  });

  return { success: true, data: summary };
}

export async function finishImport(
  jobId: string,
  resourceId: string,
): Promise<ActionResult<JobRow>> {
  const gate = await importGate(resourceId);
  if ("error" in gate) return { error: gate.error };
  const { resource, admin, storeId } = gate;

  const job = await getJob(jobId, storeId);
  if (!job) return { error: "That import can't be found." };

  await finishJob(jobId, storeId);
  const finished = (await getJob(jobId, storeId)) ?? job;

  // Everything the import could have touched. Cheap, and being conservative
  // here is much better than a merchant refreshing a storefront that still
  // shows yesterday's prices.
  revalidateTag(TAGS.products, "max");
  revalidateTag(TAGS.categories, "max");
  revalidatePath("/dashboard/products");
  revalidatePath("/dashboard/categories");
  revalidatePath("/dashboard/inventory");
  revalidatePath("/dashboard/marketing/coupons");
  revalidatePath("/shop");

  // ONE event for the job, not one per row — see the note on `data.imported`
  // in lib/notifications/events.ts.
  emitEvent({
    type: "data.imported",
    storeId,
    actor: { type: "admin", id: admin.uid, label: admin.email },
    subject: { type: "product", id: jobId, label: resource.label },
    payload: {
      resource: resource.label,
      created: finished.createdCount,
      updated: finished.updatedCount,
      skipped: finished.skippedCount,
      failed: finished.failedCount,
      status: finished.status,
      ...(finished.filename ? { file: finished.filename } : {}),
    },
  });

  // New or newly-published products need to reach search engines, the same
  // hook the single-product editor calls. Off the response path.
  if (resource.id === "products" && finished.createdCount > 0) {
    after(() =>
      notifyStoreContentPublished({
        storeId,
        paths: ["/shop", "/"],
      }).catch(() => {}),
    );
  }

  return { success: true, data: finished };
}

export async function cancelImport(
  jobId: string,
  resourceId: string,
): Promise<ActionResult> {
  const gate = await importGate(resourceId);
  if ("error" in gate) return { error: gate.error };
  const { storeId } = gate;

  const job = await getJob(jobId, storeId);
  if (!job) return { error: "That import can't be found." };

  // Cancelling stops the REST of the file. Rows already written stay written —
  // there is no undo, and pretending otherwise by silently deleting them would
  // be far worse than saying so.
  await finishJob(jobId, storeId, {
    status: "cancelled",
    error: "Stopped part-way. Rows already imported were kept.",
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Reading the log
// ---------------------------------------------------------------------------

/**
 * The job history.
 *
 * Gated on `activity` — the same permission as the other two logs it sits
 * beside (Activity and Email logs), and a different question from "may you
 * import products". Someone auditing what happened to the store's data needs
 * to see every job, not only the ones for sections they can edit.
 */
export async function getImportExportJobs(
  options: {
    kind?: "import" | "export";
    resource?: string;
    page?: number;
  } = {},
): Promise<ActionResult<{ rows: JobRow[]; total: number }>> {
  const access = await getViewerAccess();
  if (!access?.can("activity", "view"))
    return { error: "You don't have permission to view the logs." };

  const storeId = await getActingStoreId();
  // Close out anything a closed tab left mid-flight, so the history doesn't
  // show work that stopped days ago as still running. Needs no cron.
  await reapStaleJobs(storeId);

  const resource =
    options.resource && isResourceId(options.resource)
      ? (options.resource as ResourceId)
      : undefined;

  try {
    const result = await listJobs(storeId, {
      kind: options.kind,
      resource,
      page: options.page,
    });
    return { success: true, data: result };
  } catch (error) {
    logError("import/export: could not list jobs", error, { storeId });
    return { error: "Couldn't load the import and export history." };
  }
}

export async function getImportExportJob(
  jobId: string,
  options: { severity?: "error" | "warning" } = {},
): Promise<ActionResult<{ job: JobRow; issues: JobIssueRow[] }>> {
  const access = await getViewerAccess();
  if (!access?.can("activity", "view"))
    return { error: "You don't have permission to view the logs." };

  const storeId = await getActingStoreId();
  try {
    const job = await getJob(jobId, storeId);
    if (!job) return { error: "That job can't be found." };
    const issues = await getJobIssues(jobId, storeId, {
      severity: options.severity,
    });
    return { success: true, data: { job, issues } };
  } catch (error) {
    logError("import/export: could not load job", error, { jobId, storeId });
    return { error: "Couldn't load that job." };
  }
}
