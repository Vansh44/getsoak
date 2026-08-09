import { NextResponse } from "next/server";
import { after } from "next/server";
import { runImportWorker } from "@/lib/import-export/worker";
import { triggerImportWorker } from "@/lib/import-export/trigger";

// The import worker's HTTP surface — the GATE, with the work in
// lib/import-export/worker.ts.
//
// That split is not tidiness: the worker bypasses RLS with `withService` and
// takes no user context, so exported from a `"use server"` file it would be a
// publicly reachable endpoint that processes any store's jobs. Same resolution
// as `lib/retention/prune.ts` and `lib/domains/reconcile.ts` (CODEBASE §32).
//
// Driven two ways:
//   1. On demand: uploading a file calls triggerImportWorker(), so an import
//      starts within a second of the merchant clicking Import.
//   2. Cloud Scheduler as a BACKSTOP, for a chain that broke — a deploy
//      mid-slice, an OOM, a kick that never landed. Without it such a job waits
//      for a human to notice.
//
// It also SELF-CHAINS: one run applies what fits in its time budget, then kicks
// another, so a 50,000-row file drains in consecutive runs rather than needing
// 50,000 rows to fit inside one request.
//
// Auth: `Authorization: Bearer <CRON_SECRET>`.

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runImportWorker();

  // Chain only when this run actually did something. `remaining` is true after
  // any claimed job — including one that just finished — because another job
  // may be queued behind it; it is false only when the claim found nothing, so
  // the chain terminates on an empty queue rather than spinning.
  if (result.remaining) {
    after(() => triggerImportWorker());
  }

  // ★ 200 EVEN WHEN AN IMPORT FAILED. A failed import is a recorded outcome on
  // the job, not an outage — the merchant reads it in the log. Returning 5xx
  // would make Cloud Scheduler retry a job that has already given up, and a
  // permanently-red job is one nobody reads (the domain-reconcile lesson).
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
