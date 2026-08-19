import { after } from "next/server";
import {
  prepareSearchMetricWork,
  runSearchMetricWorker,
} from "@/lib/seo/search-metrics";
import { triggerSearchMetricWorker } from "@/lib/seo/search-metrics-trigger";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    !!secret && request.headers.get("authorization") === `Bearer ${secret}`
  );
}

async function handle(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Cloud Scheduler uses GET to reconcile source epochs and refresh the work
    // window once. POST is the self-chain and only drains the durable queue.
    const prepared =
      request.method === "GET" ? await prepareSearchMetricWork() : undefined;
    if (prepared?.skipped) {
      return Response.json({ ok: true, prepared });
    }
    const worker = await runSearchMetricWorker();
    if (worker.remaining) {
      after(async () => {
        // Only the global limiter pauses a chain. Normal buckets chain at once;
        // a tiny bounded delay prevents an exhausted minute window from spinning.
        if (worker.status === "rate_limited") {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        await triggerSearchMetricWorker();
      });
    }
    return Response.json({ ok: true, prepared, worker });
  } catch (error) {
    logError("search-metrics cron failed", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Search metrics cron failed",
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
