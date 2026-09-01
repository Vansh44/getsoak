import { NextResponse } from "next/server";
import { runMinkBlogPublicationWorker } from "@/lib/mink/blog-publication-worker";

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
  const result = await runMinkBlogPublicationWorker();
  // A row that fails has already rolled back and stays claimable, so the next
  // minute retries it: answering 503 for one poison row among successes is how
  // a job goes permanently red and stops being read. 503 is reserved for a run
  // that made NO progress at all, which is the signal Cloud Scheduler retries.
  const progressed = result.published + result.conflicted > 0;
  return NextResponse.json(
    { ok: result.failed === 0, ...result },
    { status: result.failed > 0 && !progressed ? 503 : 200 },
  );
}

export const GET = handle;
export const POST = handle;
