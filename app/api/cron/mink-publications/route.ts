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
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
