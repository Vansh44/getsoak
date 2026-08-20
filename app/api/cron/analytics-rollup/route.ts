import { runStorefrontAnalyticsRollup } from "@/lib/analytics/storefront-rollup";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const buckets = await runStorefrontAnalyticsRollup();
    return Response.json({ ok: true, buckets });
  } catch (error) {
    logError("analytics-rollup cron failed", error);
    return Response.json(
      { ok: false, error: "Rollup failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
