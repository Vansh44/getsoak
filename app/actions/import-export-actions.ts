"use server";

// CSV import — the trust boundary (CODEBASE.md §31).
//
// Shaped like `placeOrder` and `placePosSale`: the caller is gated first,
// everything from the browser is re-validated server-side, and the write is
// last. The browser parses the file to build a preview, but that preview is a
// COURTESY — nothing it computed is trusted here. The same pure modules run
// again on the same bytes before a single row is written.
//
// ★ WHAT IS LEFT HERE IS THE PREVIEW AND THE LOG. Running an import is no
// longer an action at all: the file is POSTed to /api/dashboard/import (a route
// handler, because a 25 MB file cannot fit through a server action's 4 MB body
// cap) and applied by lib/import-export/worker.ts, so an import survives the
// merchant closing the tab. See the note above cancelImport for what was
// deleted and why it could not simply be left in place.

import {
  getActingStoreId,
  getManagerIdentity,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import { logError } from "@/lib/observability/logger";
import { getResource, isResourceId } from "@/lib/import-export/resources";
import {
  finishJob,
  getJob,
  getJobIssues,
  listJobs,
  reapStaleJobs,
  type JobIssueRow,
  type JobRow,
} from "@/lib/import-export/jobs";
import type { ResourceId } from "@/lib/import-export/types";
// Limits live in lib/ because a "use server" file may only export async
// functions — everything exported from one is a public endpoint.
import { MAX_IMPORT_ROWS } from "@/lib/import-export/limits";
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
//
// ★ THE ACTIONS THAT RAN AN IMPORT ARE GONE — startImport / importChunk /
// finishImport. They existed so the BROWSER could drive the work a slice at a
// time, which is why closing the tab stopped an import half-applied. Uploading
// is now POST /api/dashboard/import (a route handler, because a 25 MB file
// cannot fit through a server action's 4 MB body cap) and the work is done by
// lib/import-export/worker.ts.
//
// They were DELETED rather than left unused: every export of a `"use server"`
// file is a publicly reachable endpoint, and importChunk took no lease, so a
// caller could still have applied rows to a job the worker was mid-way through
// — double-importing a slice with nothing to stop it.
// ---------------------------------------------------------------------------

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
