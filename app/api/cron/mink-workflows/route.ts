import { NextResponse } from "next/server";
import { runMinkWorkflowWorker } from "@/lib/mink/workflows";
import { scheduleMinkWatches, reconcileMinkWatches } from "@/lib/mink/watches";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    typeof secret === "string" &&
    secret.length > 0 &&
    request.headers.get("authorization") === `Bearer ${secret}`
  );
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Independent passes: a scheduler failure must not strand manual workflows.
    let passError: unknown = null;
    let watchesQueued = 0;
    try {
      watchesQueued = await scheduleMinkWatches();
    } catch (error) {
      passError = error;
    }
    let result: Awaited<ReturnType<typeof runMinkWorkflowWorker>> | null = null;
    try {
      result = await runMinkWorkflowWorker();
    } catch (error) {
      passError ??= error;
    }
    let watchAlerts = 0;
    try {
      watchAlerts = await reconcileMinkWatches();
    } catch (error) {
      passError ??= error;
    }
    if (passError) throw passError;
    if (!result) throw new Error("Workflow heartbeat returned no result.");
    return NextResponse.json({
      ok: result.workflowsFailed === 0,
      ...result,
      watchesQueued,
      watchAlerts,
    });
  } catch (error) {
    // 503, not an unhandled 500, so Cloud Scheduler's retries engage — the
    // same contract prune-logs and seo-refresh answer on a failed pass. A
    // workflow that failed its own retries is still a 200 with `ok: false`:
    // that is the queue working, not an outage.
    logError("mink workflow cron: heartbeat failed", error);
    return NextResponse.json(
      { ok: false, error: "Mink workflow heartbeat failed." },
      { status: 503 },
    );
  }
}

export const GET = handle;
export const POST = handle;
