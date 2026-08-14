import { eq } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { submitSitemapToGoogle } from "@/lib/seo/search-engines";
import { ensureGoogleCoverageForStore } from "@/lib/seo/store-indexing";
import { HELP_URL, PLATFORM_URL, POS_URL, THEMES_URL } from "@/lib/site";
import { SEARCH_INDEXABLE } from "@/lib/store/host";
import { isStoreLaunched } from "@/lib/store/launch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CONCURRENCY = 4;

const ROOT_SITEMAPS = [
  { site: "platform", url: `${PLATFORM_URL}/sitemap.xml` },
  { site: "help", url: `${HELP_URL}/sitemap.xml` },
  { site: "pos", url: `${POS_URL}/sitemap.xml` },
  { site: "themes", url: `${THEMES_URL}/sitemap.xml` },
] as const;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    !!secret && request.headers.get("authorization") === `Bearer ${secret}`
  );
}

async function mapConcurrent<T, R>(
  values: T[],
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await worker(values[index]);
      }
    }),
  );
  return results;
}

async function handle(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!SEARCH_INDEXABLE) {
    return Response.json({ ok: true, skipped: "search indexing disabled" });
  }

  try {
    // Root properties are cheap, fixed registrations. Repeating these PUTs
    // daily is intentional: a missing IAM grant or transient Google failure
    // self-heals without a human remembering a one-time deployment step.
    const rootResults = await Promise.all(
      ROOT_SITEMAPS.map(({ url }) => submitSitemapToGoogle(url)),
    );

    const rows = await withService((db) =>
      db
        .select({ id: stores.id, settings: stores.settings })
        .from(stores)
        .where(eq(stores.status, "active")),
    );
    const eligible = rows
      .map((row) => ({
        ...row,
        settings: (row.settings ?? {}) as Record<string, unknown>,
      }))
      .filter((row) => isStoreLaunched(row) && row.settings.demo !== true);
    const storeResults = await mapConcurrent(eligible, (row) =>
      ensureGoogleCoverageForStore(row.id),
    );
    const failures = storeResults
      .map((result, index) => ({ result, storeId: eligible[index].id }))
      .filter(({ result }) => !result.ok)
      .map(({ result, storeId }) => ({ storeId, error: result.error }));

    const ok =
      rootResults.every((result) => result.ok) && failures.length === 0;
    return Response.json(
      {
        ok,
        roots: rootResults.map((result, index) => ({
          site: ROOT_SITEMAPS[index].site,
          sitemap: ROOT_SITEMAPS[index].url,
          ok: result.ok,
          ...(!result.ok ? { error: result.error } : {}),
        })),
        stores: {
          eligible: eligible.length,
          ready: storeResults.filter((result) => result.ok).length,
          failed: failures.length,
          failures,
        },
      },
      // Cloud Scheduler retries non-2xx responses. Returning 200 with
      // {ok:false} made a broken IAM grant look like a completed job.
      { status: ok ? 200 : 503 },
    );
  } catch (err) {
    logError("seo-refresh cron failed", err);
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "SEO refresh failed",
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
