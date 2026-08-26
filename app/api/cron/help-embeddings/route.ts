import { after } from "next/server";
import { runHelpEmbeddingWorker } from "@/lib/help/embedding-worker";
import { triggerHelpEmbeddingWorker } from "@/lib/help/embedding-trigger";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    const worker = await runHelpEmbeddingWorker();
    if (worker.remaining && worker.failed === 0) {
      after(() => triggerHelpEmbeddingWorker());
    }
    return Response.json(
      { ok: worker.failed === 0, worker },
      { status: worker.failed === 0 ? 200 : 503 },
    );
  } catch (error) {
    logError("help-embeddings cron failed", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Help embedding worker failed",
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
