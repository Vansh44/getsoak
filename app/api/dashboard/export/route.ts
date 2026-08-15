import { NextResponse } from "next/server";
import { after } from "next/server";
import { getActingStoreId, getViewerContext } from "@/app/dashboard/lib/access";
import { getViewerLocations } from "@/lib/locations/scope";
import { can } from "@/app/dashboard/lib/permissions";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
import { emitEvent } from "@/lib/notifications/record";
import { serializeCsvRow } from "@/lib/csv/serialize";
import { exportRows } from "@/lib/import-export/exporters";
import {
  exportHeader,
  getResource,
  templateRows,
  toCells,
} from "@/lib/import-export/resources";
import { addProgress, createJob, finishJob } from "@/lib/import-export/jobs";
import type { ResourceId } from "@/lib/import-export/types";

// Node runtime: the exporters open user-scoped Postgres transactions.
export const runtime = "nodejs";

/**
 * CSV export — a ROUTE, not a server action, and it streams.
 *
 * A server action would have to build the whole file in memory and return it
 * as one value: a 40,000-product export is tens of megabytes held twice (once
 * as the string, once as the serialised response), on a container with a fixed
 * memory limit, and the merchant stares at a dead page for thirty seconds
 * before any of it arrives. A route can set Content-Disposition, so the browser
 * treats it as a download, and write rows as it reads them — memory stays at
 * one page and the file starts saving immediately.
 *
 * ⚠ THE STATUS CODE IS COMMITTED BEFORE THE FIRST ROW. Once headers are sent,
 * a failure mid-stream cannot become a 500 — the browser has a partial file and
 * a 200. So the failure is recorded on the JOB (which is why an export gets a
 * job row at all) and the stream is terminated with a visible marker rather
 * than trailing off, because a silently truncated CSV is one a merchant will
 * reimport believing it complete.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resource") ?? "";
  const wantsTemplate = url.searchParams.get("template") === "1";

  const resource = getResource(resourceId);
  if (!resource) {
    return NextResponse.json(
      { error: "Unknown thing to export." },
      { status: 400 },
    );
  }
  if (!resource.canExport) {
    return NextResponse.json(
      { error: `${resource.label} can't be exported.` },
      { status: 400 },
    );
  }

  const ctx = await getViewerContext();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (ctx.dbError) {
    // The access lookup failed, which is NOT the same as "no access" — the
    // access.ts rule. Saying "forbidden" here would accuse a legitimate owner.
    return NextResponse.json(
      { error: "Can't check your permissions right now. Try again shortly." },
      { status: 503 },
    );
  }

  // EXPORT NEEDS `view`, NOT `manage`. Downloading is a read, and someone who
  // may look at the orders list may take a copy of it. Import is the write, and
  // it is gated on `manage` in import-export-actions.ts.
  const allowed =
    can(ctx.permissions, resource.section, "view", ctx.isSuperadmin) &&
    (resource.alsoRequires ?? []).every((extra) =>
      can(ctx.permissions, extra, "view", ctx.isSuperadmin),
    );
  if (!allowed) {
    return NextResponse.json(
      { error: "You don't have permission to export this." },
      { status: 403 },
    );
  }

  const storeId = await getActingStoreId();
  const admin = { uid: ctx.userId, email: ctx.userEmail };
  // ★ RESOLVED HERE, at the gate, not inside each exporter — one place to get
  // it right, and one place to look when asking whether an export is bounded.
  const locationScope = await getViewerLocations();
  const stamp = new Date().toISOString().slice(0, 10);

  // --- the blank template ---------------------------------------------------
  // Small, static, and not worth a job row or a rate-limit slot.
  if (wantsTemplate) {
    const { header, example } = templateRows(resource);
    const body = "﻿" + serializeCsvRow(header) + serializeCsvRow(example);
    return new NextResponse(body, {
      headers: csvHeaders(`${resource.id}-template.csv`),
    });
  }

  // Per store: an export is a full table scan, and two admins running one at
  // once is the same load as one running two.
  const limit = await rateLimit(`export:${storeId}`, {
    max: 30,
    windowSeconds: 3600,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "That's a lot of exports in one hour. Try again shortly." },
      { status: 429 },
    );
  }

  const filters: Record<string, string | undefined> = {
    status: url.searchParams.get("status") ?? undefined,
    location: url.searchParams.get("location") ?? undefined,
  };

  const filename = `${resource.id}-${stamp}.csv`;

  let jobId: string | null = null;
  try {
    jobId = await createJob({
      storeId,
      kind: "export",
      resource: resource.id as ResourceId,
      filename,
      options: filters,
      actor: admin,
    });
  } catch (error) {
    // A missing job row costs the audit trail, not the download. Refusing to
    // export because logging failed would be the wrong way round.
    logError("export: could not create job", error, { resource: resource.id });
  }

  const encoder = new TextEncoder();
  let rowCount = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // BOM first: without it Excel on Windows reads UTF-8 as the system
        // codepage, so `Café` becomes `CafÃ©` and gets reimported that way.
        controller.enqueue(encoder.encode("﻿"));
        controller.enqueue(
          encoder.encode(serializeCsvRow(exportHeader(resource))),
        );

        for await (const record of exportRows(resource.id as ResourceId, {
          storeId,
          admin,
          filters,
          locationScope,
        })) {
          controller.enqueue(
            encoder.encode(serializeCsvRow(toCells(resource, record))),
          );
          rowCount++;
        }

        controller.close();

        if (jobId) {
          const id = jobId;
          after(async () => {
            await addProgress(id, storeId, {
              processed: rowCount,
              created: rowCount,
            });
            await finishJob(id, storeId, { status: "completed" });
            emitEvent({
              type: "data.exported",
              storeId,
              actor: { type: "admin", id: admin.uid, label: admin.email },
              subject: { type: "product", id, label: resource.label },
              payload: {
                resource: resource.label,
                rows: rowCount,
                file: filename,
              },
            });
          });
        }
      } catch (error) {
        logError("export: stream failed", error, {
          resource: resource.id,
          rowCount,
        });

        // The headers left long ago, so this cannot be a 500. Write a marker
        // the merchant will see when they open the file — a CSV that simply
        // stops looks complete, and they would reimport it and wonder where
        // half their catalogue went.
        try {
          controller.enqueue(
            encoder.encode(
              serializeCsvRow([
                `EXPORT FAILED after ${rowCount} rows — this file is incomplete. See Activity logs → Imports & exports.`,
              ]),
            ),
          );
        } catch {
          // The client is already gone; nothing to tell.
        }
        controller.close();

        if (jobId) {
          const id = jobId;
          after(async () => {
            await addProgress(id, storeId, { processed: rowCount });
            await finishJob(id, storeId, {
              status: "failed",
              error: `Stopped after ${rowCount} rows: ${error instanceof Error ? error.message : "unknown error"}`,
            });
          });
        }
      }
    },

    cancel() {
      // The merchant hit Stop, or the connection dropped. The file they have is
      // partial, and the log should say so rather than claim a clean export.
      if (!jobId) return;
      const id = jobId;
      after(async () => {
        await finishJob(id, storeId, {
          status: "cancelled",
          error: `Download stopped after ${rowCount} rows.`,
        });
      });
    },
  });

  return new NextResponse(stream, { headers: csvHeaders(filename) });
}

function csvHeaders(filename: string): HeadersInit {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    // A store's own data must never sit in a shared cache, and a merchant who
    // exports twice in a day needs the second file to be the second file.
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
  };
}
