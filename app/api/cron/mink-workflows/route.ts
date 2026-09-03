import { NextResponse } from "next/server";
import { runMinkWorkflowWorker } from "@/lib/mink/workflows";

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
  const result = await runMinkWorkflowWorker();
  return NextResponse.json({ ok: result.workflowsFailed === 0, ...result });
}

export const GET = handle;
export const POST = handle;
