import { NextResponse } from "next/server";
import { after } from "next/server";
import { withService } from "@/lib/db/client";
import { dataJobPayloads } from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
import { emitEvent } from "@/lib/notifications/record";
import { parseCsv } from "@/lib/csv/parse";
import { parseFile } from "@/lib/import-export/parse";
import { getResource } from "@/lib/import-export/resources";
import { createJob } from "@/lib/import-export/jobs";
import { triggerImportWorker } from "@/lib/import-export/trigger";
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
} from "@/lib/import-export/limits";

// Upload a CSV and queue it. The trust boundary for every import.
//
// ★ A ROUTE HANDLER, NOT A SERVER ACTION, AND THAT IS FORCED. A server action's
// body cap is 4 MB (next.config.ts) while an import file may be 25 MB, so the
// file cannot travel through one. It is also why the browser used to chunk the
// rows itself — a design that made the import die with the tab. One authenticated
// POST is atomic instead: either the job is queued or nothing happened.
//
// The file is stored in Postgres (data_job_payloads), NOT the media bucket —
// that bucket is `allUsers:objectViewer`, and the same code path carries orders
// data with customer names, addresses and phone numbers. See the migration.

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { error: "Expected a file upload." },
      { status: 400 },
    );
  }

  const resourceId = String(form.get("resource") ?? "");
  const file = form.get("file");
  const resource = getResource(resourceId);

  if (!resource) {
    return NextResponse.json(
      { error: "Unknown thing to import." },
      { status: 400 },
    );
  }
  if (!resource.canImport) {
    return NextResponse.json(
      { error: `${resource.label} can be exported but not imported.` },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "No file was uploaded." },
      { status: 400 },
    );
  }

  // ★ THE GATE IS THE RESOURCE'S OWN SECTION, never an `import_export` key of
  // its own — that would be a way to grant write access to the whole catalogue
  // without granting Products, a grant that looks narrow and is the widest in
  // the system. Inventory additionally needs Products (`alsoRequires`), because
  // resolving a SKU is a product read.
  const admin = await getManagerIdentity(resource.section);
  if (!admin) {
    return NextResponse.json(
      { error: "You don't have permission to import this." },
      { status: 403 },
    );
  }
  for (const extra of resource.alsoRequires ?? []) {
    if (!(await getManagerIdentity(extra))) {
      return NextResponse.json(
        { error: "You don't have permission to import this." },
        { status: 403 },
      );
    }
  }

  const storeId = await getActingStoreId();

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return NextResponse.json(
      {
        error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB — split it into a few smaller files.`,
      },
      { status: 413 },
    );
  }

  // Per-store, not per-user: the cost is database write throughput, and two
  // admins importing the catalogue at once is the same load as one doing it
  // twice. Generous, because a real migration is several files.
  const limit = await rateLimit(`import:${storeId}`, {
    max: 20,
    windowSeconds: 3600,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error:
          "That's a lot of imports in one hour. Give it a few minutes and try again.",
      },
      { status: 429 },
    );
  }

  const text = await file.text();
  const csv = parseCsv(text, { maxRows: MAX_IMPORT_ROWS });

  if (csv.header.length === 0) {
    return NextResponse.json(
      { error: "That file has no header row." },
      { status: 400 },
    );
  }
  if (csv.rows.length === 0) {
    return NextResponse.json(
      { error: "That file has no rows." },
      { status: 400 },
    );
  }
  if (csv.rows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json(
      {
        error: `That file has ${csv.rows.length.toLocaleString("en-IN")} rows. Imports are limited to ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} at a time — split it and run them one after another.`,
      },
      { status: 413 },
    );
  }

  // Reject a file we could never apply BEFORE queuing it. A job that exists
  // only to fail immediately is worse than an error at the point of upload:
  // the merchant has navigated away by the time it appears.
  const probe = parseFile(resource.id, {
    header: csv.header,
    rows: csv.rows.slice(0, 1),
    delimiter: csv.delimiter,
    raggedLines: [],
    truncated: false,
  });
  if ("error" in probe) {
    return NextResponse.json({ error: probe.error }, { status: 400 });
  }

  const options = {
    create: form.get("create") !== "false",
    update: form.get("update") !== "false",
    locationId: (form.get("locationId") as string) || null,
  };

  try {
    const jobId = await createJob({
      storeId,
      kind: "import",
      resource: resource.id,
      filename: file.name || null,
      totalRows: csv.rows.length,
      options: { ...options, header: csv.header },
      actor: { uid: admin.uid, email: admin.email },
    });

    // The payload and the job are written separately, so a failure here would
    // leave a job with no file — which the worker reports as a failed job
    // rather than retrying forever.
    await withService((db) =>
      db.insert(dataJobPayloads).values({
        jobId,
        storeId,
        header: csv.header,
        csv: text,
      }),
    );

    emitEvent({
      type: "data.import_started",
      storeId,
      actor: { type: "admin", id: admin.uid, label: admin.email },
      subject: { type: "product", id: jobId, label: resource.label },
      payload: {
        resource: resource.label,
        rows: csv.rows.length,
        ...(file.name ? { file: file.name } : {}),
      },
    });

    // Start it now rather than at the next sweep. Deferred so the merchant's
    // response isn't held open on it, and best-effort — the cron backstop picks
    // the job up if this never lands.
    after(() => triggerImportWorker());

    return NextResponse.json({ jobId, rows: csv.rows.length });
  } catch (error) {
    logError("import: could not queue", error, { resource: resource.id });
    return NextResponse.json(
      { error: "Couldn't start the import. Please try again." },
      { status: 500 },
    );
  }
}
