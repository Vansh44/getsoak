import { NextResponse } from "next/server";
import { runRetentionSweep } from "@/lib/retention/prune";
import { logError } from "@/lib/observability/logger";

// Daily log retention. Deletes notifications, activity_events and email_logs
// past the windows in lib/retention/prune.ts — the windows, the batching and
// the reasoning all live there; this file is only the gate.
//
// The windows were documented in three places and enforced in none: nothing
// ever called the prune function, so every one of these tables had grown
// unbounded since it was created. See docs/cron-jobs.md.
//
// Auth: requires `Authorization: Bearer <CRON_SECRET>`, like every other cron
// route. Set CRON_SECRET in the environment; Cloud Scheduler sends the header.

export const runtime = "nodejs";
// Matches the Cloud Scheduler attempt deadline; the sweep stops itself at 240s
// so it can still report what it did.
export const maxDuration = 300;
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

  let sweep: Awaited<ReturnType<typeof runRetentionSweep>>;
  try {
    sweep = await runRetentionSweep();
  } catch (err) {
    // runRetentionSweep contains its own per-table failures, so reaching here
    // means something outside the loop broke.
    logError("prune-logs: sweep threw", err);
    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }

  const body = {
    ok: !sweep.failed,
    deleted: sweep.deleted,
    // Per table: how many went, and why the sweep stopped where it did.
    tables: sweep.results.map((r) => ({
      table: r.table,
      days: r.days,
      deleted: r.deleted,
      stop: r.stop,
      ...(r.error ? { error: r.error } : {}),
    })),
    // A backlog draining over several nights is normal, not a failure.
    incomplete: sweep.incomplete,
  };

  // 503 on a real failure so Cloud Scheduler's retries engage — the
  // seo-refresh contract. `incomplete` stays 200 deliberately: a first sweep
  // over a long backlog hits its cap by design, and a permanently-red job is
  // one nobody reads (the domain-reconcile lesson).
  return NextResponse.json(body, { status: sweep.failed ? 503 : 200 });
}

export const GET = handle;
export const POST = handle;
