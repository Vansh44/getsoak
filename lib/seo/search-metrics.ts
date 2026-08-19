import "server-only";

import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  storeSearchMetrics,
  storeSearchSources,
  storeSearchSyncJobs,
  stores,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  queryGoogleSearchAnalytics,
  type GoogleSearchAnalyticsRequest,
} from "@/lib/seo/search-engines";
import { storeOrigin } from "@/lib/site";
import { ROOT_DOMAIN, SEARCH_INDEXABLE } from "@/lib/store/host";
import { isStoreSearchIndexable } from "@/lib/store/launch";
import {
  SEARCH_DIMENSION_LIMITS,
  SEARCH_CORRECTION_DAYS,
  SEARCH_RETENTION_DAYS,
  addSearchDays,
  correctionDates,
  mondayForSearchDate,
  normalizeSearchRows,
  pacificDate,
  pageFilterForOrigin,
  type SearchMetricDimension,
  type SearchSourceKind,
} from "./search-performance";

export const SEARCH_JOB_LEASE_MS = 2 * 60 * 1000;
export const SEARCH_JOB_MAX_ATTEMPTS = 5;
export const SEARCH_PROPERTY_QPM_LIMIT = 1100;
const SEARCH_PREP_CONCURRENCY = 8;

interface SourceRow {
  id: string;
  storeId: string;
  kind: string;
  origin: string;
  property: string;
  pageFilter: string | null;
  firstDataDate: string;
  finalDataDate: string | null;
  correctionUntil: string | null;
}

interface ClaimedSearchJob {
  sourceId: string;
  storeId: string;
  date: string;
  dimension: SearchMetricDimension;
  attempts: number;
  source: SourceRow;
}

function latestDate(left: string, right: string): string {
  return left > right ? left : right;
}

function dateInsideSource(source: SourceRow, start: string, end = start) {
  if (start < source.firstDataDate) return false;
  return !source.finalDataDate || end <= source.finalDataDate;
}

async function mapConcurrent<T, R>(
  values: T[],
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(SEARCH_PREP_CONCURRENCY, values.length) },
      async () => {
        while (cursor < values.length) {
          const index = cursor++;
          results[index] = await worker(values[index]);
        }
      },
    ),
  );
  return results;
}

function sourceDefinition(origin: string): {
  kind: SearchSourceKind;
  property: string;
  pageFilter: string | null;
} {
  const host = new URL(origin).hostname;
  const platform = host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`);
  if (platform) {
    return {
      kind: "platform_subdomain",
      property:
        process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY ??
        `sc-domain:${ROOT_DOMAIN}`,
      pageFilter: pageFilterForOrigin(origin).expression,
    };
  }
  return {
    kind: "custom_domain",
    property: `${origin}/`,
    pageFilter: null,
  };
}

/** Reconcile the one active source epoch for a store. Advisory locking makes a
 * Scheduler retry and an overlapping self-chain idempotent. */
async function reconcileStoreSource(input: {
  id: string;
  slug: string;
  status: string;
  plan: string;
  plan_expires_at: string | null;
  custom_domain: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
}): Promise<void> {
  const eligible = input.status === "active" && isStoreSearchIndexable(input);
  const wantedOrigin = eligible ? storeOrigin(input) : null;
  const today = pacificDate();
  const closedFinalDate = addSearchDays(today, -1);

  await withService(async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`store-search:${input.id}`}))`,
    );
    const existing = await db
      .select({
        id: storeSearchSources.id,
        origin: storeSearchSources.origin,
        firstDataDate: storeSearchSources.firstDataDate,
        inactiveAt: storeSearchSources.inactiveAt,
      })
      .from(storeSearchSources)
      .where(eq(storeSearchSources.storeId, input.id))
      .orderBy(asc(storeSearchSources.activeFrom));
    const active = existing.find((row) => row.inactiveAt === null);
    if (active && active.origin === wantedOrigin) return;

    if (active) {
      const finalDataDate = latestDate(active.firstDataDate, closedFinalDate);
      await db
        .update(storeSearchSources)
        .set({
          inactiveAt: new Date().toISOString(),
          finalDataDate,
          correctionUntil: addSearchDays(finalDataDate, 3),
        })
        .where(eq(storeSearchSources.id, active.id));
    }

    if (!wantedOrigin) return;
    const definition = sourceDefinition(wantedOrigin);
    const retentionFloor = addSearchDays(today, -SEARCH_RETENTION_DAYS);
    // A current legacy store can safely backfill to its own creation date. An
    // origin transition starts on the first full PT day after detection so a
    // reassigned custom domain can never leak its boundary-day traffic.
    const verifiedAt = input.settings.google_site_verified_at;
    const verifiedDate =
      typeof verifiedAt === "string" &&
      Number.isFinite(new Date(verifiedAt).getTime())
        ? addSearchDays(pacificDate(new Date(verifiedAt)), 1)
        : null;
    const firstDataDate =
      existing.length === 0 && definition.kind === "platform_subdomain"
        ? latestDate(retentionFloor, pacificDate(new Date(input.createdAt)))
        : existing.length === 0 && verifiedDate
          ? latestDate(retentionFloor, verifiedDate)
          : addSearchDays(today, 1);
    await db.insert(storeSearchSources).values({
      storeId: input.id,
      kind: definition.kind,
      origin: wantedOrigin,
      property: definition.property,
      pageFilter: definition.pageFilter,
      activeFrom: new Date().toISOString(),
      firstDataDate,
    });
  });
}

/** Immediate lifecycle hook for publish/domain workflows. The daily preparation
 * remains the backstop, but the ownership boundary is recorded in the same
 * successful workflow that changes the canonical origin. */
export async function reconcileStoreSearchSource(
  storeId: string,
): Promise<void> {
  if (!SEARCH_INDEXABLE) return;
  const [row] = await withService((db) =>
    db
      .select({
        id: stores.id,
        slug: stores.slug,
        status: stores.status,
        plan: stores.plan,
        plan_expires_at: stores.planExpiresAt,
        custom_domain: stores.customDomain,
        settings: stores.settings,
        createdAt: stores.createdAt,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  if (!row) return;
  await reconcileStoreSource({
    ...row,
    settings: (row.settings ?? {}) as Record<string, unknown>,
  });
}

async function enqueueSourceJobs(
  source: SourceRow,
  now: Date,
): Promise<number> {
  const jobs: Array<{
    sourceId: string;
    storeId: string;
    date: string;
    dimension: SearchMetricDimension;
  }> = [];
  for (const date of correctionDates(now)) {
    if (!dateInsideSource(source, date)) continue;
    for (const dimension of ["total", "query", "page"] as const) {
      jobs.push({
        sourceId: source.id,
        storeId: source.storeId,
        date,
        dimension,
      });
    }
  }

  // Weekly dimensions are recomputed on Monday PT and use a complete prior
  // Monday–Sunday bucket. Partial source-boundary weeks are intentionally not
  // claimed as complete data.
  const today = pacificDate(now);
  if (today === mondayForSearchDate(today)) {
    const weekStart = addSearchDays(mondayForSearchDate(today), -7);
    const weekEnd = addSearchDays(weekStart, 6);
    if (dateInsideSource(source, weekStart, weekEnd)) {
      for (const dimension of ["country", "device"] as const) {
        jobs.push({
          sourceId: source.id,
          storeId: source.storeId,
          date: weekStart,
          dimension,
        });
      }
    }
  }
  if (!jobs.length) return 0;

  await withService((db) =>
    db
      .insert(storeSearchSyncJobs)
      .values(jobs)
      .onConflictDoUpdate({
        target: [
          storeSearchSyncJobs.sourceId,
          storeSearchSyncJobs.date,
          storeSearchSyncJobs.dimension,
        ],
        set: {
          status: sql`CASE WHEN ${storeSearchSyncJobs.status} = 'running' AND ${storeSearchSyncJobs.leaseUntil} > now() THEN ${storeSearchSyncJobs.status} ELSE 'queued' END`,
          attempts: sql`CASE WHEN ${storeSearchSyncJobs.status} = 'running' AND ${storeSearchSyncJobs.leaseUntil} > now() THEN ${storeSearchSyncJobs.attempts} ELSE 0 END`,
          completedAt: sql`CASE WHEN ${storeSearchSyncJobs.status} = 'running' AND ${storeSearchSyncJobs.leaseUntil} > now() THEN ${storeSearchSyncJobs.completedAt} ELSE NULL END`,
          lastError: sql`CASE WHEN ${storeSearchSyncJobs.status} = 'running' AND ${storeSearchSyncJobs.leaseUntil} > now() THEN ${storeSearchSyncJobs.lastError} ELSE NULL END`,
          updatedAt: new Date().toISOString(),
        },
      }),
  );
  return jobs.length;
}

export interface SearchWorkPreparation {
  skipped?: string;
  stores: number;
  sources: number;
  jobs: number;
}

/** Scheduler-side fleet preparation. The self-chain only drains jobs; it does
 * not repeatedly reset already completed buckets. */
export async function prepareSearchMetricWork(
  now: Date = new Date(),
): Promise<SearchWorkPreparation> {
  if (!SEARCH_INDEXABLE) {
    return {
      skipped: "search indexing disabled",
      stores: 0,
      sources: 0,
      jobs: 0,
    };
  }
  const storeRows = await withService((db) =>
    db
      .select({
        id: stores.id,
        slug: stores.slug,
        status: stores.status,
        plan: stores.plan,
        plan_expires_at: stores.planExpiresAt,
        custom_domain: stores.customDomain,
        settings: stores.settings,
        createdAt: stores.createdAt,
      })
      .from(stores),
  );
  await mapConcurrent(storeRows, (row) =>
    reconcileStoreSource({
      ...row,
      settings: (row.settings ?? {}) as Record<string, unknown>,
    }),
  );

  const today = pacificDate(now);
  const sourceRows = await withService((db) =>
    db
      .select({
        id: storeSearchSources.id,
        storeId: storeSearchSources.storeId,
        kind: storeSearchSources.kind,
        origin: storeSearchSources.origin,
        property: storeSearchSources.property,
        pageFilter: storeSearchSources.pageFilter,
        firstDataDate: storeSearchSources.firstDataDate,
        finalDataDate: storeSearchSources.finalDataDate,
        correctionUntil: storeSearchSources.correctionUntil,
      })
      .from(storeSearchSources)
      .where(
        or(
          isNull(storeSearchSources.inactiveAt),
          sql`${storeSearchSources.correctionUntil} >= ${today}`,
        ),
      ),
  );
  const enqueued = await mapConcurrent(sourceRows, (source) =>
    enqueueSourceJobs(source, now),
  );
  const jobs = enqueued.reduce((sum, count) => sum + count, 0);
  return { stores: storeRows.length, sources: sourceRows.length, jobs };
}

async function claimSearchJobs(): Promise<ClaimedSearchJob[]> {
  const now = new Date();
  const leaseUntil = new Date(
    now.getTime() + SEARCH_JOB_LEASE_MS,
  ).toISOString();
  return withService(async (db) => {
    const [candidate] = await db
      .select({
        sourceId: storeSearchSyncJobs.sourceId,
        date: storeSearchSyncJobs.date,
        dimension: storeSearchSyncJobs.dimension,
      })
      .from(storeSearchSyncJobs)
      .where(
        and(
          inArray(storeSearchSyncJobs.status, ["queued", "running"]),
          lt(storeSearchSyncJobs.attempts, SEARCH_JOB_MAX_ATTEMPTS),
          or(
            isNull(storeSearchSyncJobs.leaseUntil),
            lt(storeSearchSyncJobs.leaseUntil, now.toISOString()),
          ),
        ),
      )
      .orderBy(
        asc(storeSearchSyncJobs.updatedAt),
        asc(storeSearchSyncJobs.date),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return [];

    const [job] = await db
      .update(storeSearchSyncJobs)
      .set({
        status: "running",
        leaseUntil,
        attempts: sql`${storeSearchSyncJobs.attempts} + 1`,
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(storeSearchSyncJobs.sourceId, candidate.sourceId),
          eq(storeSearchSyncJobs.date, candidate.date),
          eq(storeSearchSyncJobs.dimension, candidate.dimension),
        ),
      )
      .returning({
        sourceId: storeSearchSyncJobs.sourceId,
        storeId: storeSearchSyncJobs.storeId,
        date: storeSearchSyncJobs.date,
        dimension: storeSearchSyncJobs.dimension,
        attempts: storeSearchSyncJobs.attempts,
      });
    if (!job) return [];
    const jobs = [job];

    // Totals are one date row each in the durable queue, but Google can return
    // all five correction dates in one totals-by-date request. Lease the peer
    // rows in this same transaction so no second instance can issue a duplicate
    // batch while the API call is in flight.
    if (candidate.dimension === "total") {
      const peers = await db
        .select({ date: storeSearchSyncJobs.date })
        .from(storeSearchSyncJobs)
        .where(
          and(
            eq(storeSearchSyncJobs.sourceId, candidate.sourceId),
            eq(storeSearchSyncJobs.dimension, "total"),
            sql`${storeSearchSyncJobs.date} <> ${candidate.date}::date`,
            inArray(storeSearchSyncJobs.status, ["queued", "running"]),
            lt(storeSearchSyncJobs.attempts, SEARCH_JOB_MAX_ATTEMPTS),
            or(
              isNull(storeSearchSyncJobs.leaseUntil),
              lt(storeSearchSyncJobs.leaseUntil, now.toISOString()),
            ),
          ),
        )
        .orderBy(asc(storeSearchSyncJobs.date))
        .limit(SEARCH_CORRECTION_DAYS - 1)
        .for("update", { skipLocked: true });
      if (peers.length) {
        const claimedPeers = await db
          .update(storeSearchSyncJobs)
          .set({
            status: "running",
            leaseUntil,
            attempts: sql`${storeSearchSyncJobs.attempts} + 1`,
            updatedAt: now.toISOString(),
          })
          .where(
            and(
              eq(storeSearchSyncJobs.sourceId, candidate.sourceId),
              eq(storeSearchSyncJobs.dimension, "total"),
              inArray(
                storeSearchSyncJobs.date,
                peers.map((peer) => peer.date),
              ),
            ),
          )
          .returning({
            sourceId: storeSearchSyncJobs.sourceId,
            storeId: storeSearchSyncJobs.storeId,
            date: storeSearchSyncJobs.date,
            dimension: storeSearchSyncJobs.dimension,
            attempts: storeSearchSyncJobs.attempts,
          });
        jobs.push(...claimedPeers);
      }
    }
    const [source] = await db
      .select({
        id: storeSearchSources.id,
        storeId: storeSearchSources.storeId,
        kind: storeSearchSources.kind,
        origin: storeSearchSources.origin,
        property: storeSearchSources.property,
        pageFilter: storeSearchSources.pageFilter,
        firstDataDate: storeSearchSources.firstDataDate,
        finalDataDate: storeSearchSources.finalDataDate,
        correctionUntil: storeSearchSources.correctionUntil,
      })
      .from(storeSearchSources)
      .where(
        and(
          eq(storeSearchSources.id, jobs[0].sourceId),
          eq(storeSearchSources.storeId, jobs[0].storeId),
        ),
      )
      .limit(1);
    if (!source) return [];
    return jobs.map((claimed) => ({
      ...claimed,
      dimension: claimed.dimension as SearchMetricDimension,
      source,
    }));
  });
}

async function claimRateSlot(property: string): Promise<boolean> {
  const result = await withService((db) =>
    db.execute(
      sql`select public.claim_store_search_rate_slot(${property}, ${SEARCH_PROPERTY_QPM_LIMIT}) as claimed`,
    ),
  );
  return (
    (result.rows[0] as { claimed?: boolean } | undefined)?.claimed === true
  );
}

function requestForJobs(
  jobs: ClaimedSearchJob[],
): GoogleSearchAnalyticsRequest {
  const job = jobs[0];
  const weekly = job.dimension === "country" || job.dimension === "device";
  const dates = jobs.map((item) => item.date).sort();
  const endDate = weekly ? addSearchDays(job.date, 6) : dates.at(-1)!;
  const request: GoogleSearchAnalyticsRequest = {
    startDate: dates[0],
    endDate,
    dimensions: job.dimension === "total" ? ["date"] : [job.dimension],
    aggregationType:
      job.source.kind === "platform_subdomain" ? "auto" : "byPage",
    rowLimit:
      job.dimension === "total"
        ? SEARCH_CORRECTION_DAYS
        : SEARCH_DIMENSION_LIMITS[job.dimension],
    dataState: "final",
  };
  if (job.source.pageFilter) {
    request.dimensionFilterGroups = [
      {
        filters: [
          {
            dimension: "page",
            operator: "includingRegex",
            expression: job.source.pageFilter,
          },
        ],
      },
    ];
  }
  return request;
}

async function releaseRateLimitedJob(job: ClaimedSearchJob): Promise<void> {
  await withService((db) =>
    db
      .update(storeSearchSyncJobs)
      .set({
        status: "queued",
        leaseUntil: null,
        attempts: sql`greatest(${storeSearchSyncJobs.attempts} - 1, 0)`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(storeSearchSyncJobs.sourceId, job.sourceId),
          eq(storeSearchSyncJobs.date, job.date),
          eq(storeSearchSyncJobs.dimension, job.dimension),
        ),
      ),
  );
}

async function replaceSearchBucket(
  job: ClaimedSearchJob,
  rows: ReturnType<typeof normalizeSearchRows>,
): Promise<void> {
  const storedRows =
    job.dimension === "total" && rows.length === 0
      ? [{ key: "", clicks: 0, impressions: 0, positionSum: "0.0000" }]
      : rows;
  const syncedAt = new Date().toISOString();
  await withService(async (db) => {
    await db
      .delete(storeSearchMetrics)
      .where(
        and(
          eq(storeSearchMetrics.sourceId, job.sourceId),
          eq(storeSearchMetrics.date, job.date),
          eq(storeSearchMetrics.dimension, job.dimension),
        ),
      );
    if (storedRows.length) {
      await db.insert(storeSearchMetrics).values(
        storedRows.map((row) => ({
          sourceId: job.sourceId,
          storeId: job.storeId,
          date: job.date,
          dimension: job.dimension,
          ...row,
        })),
      );
    }
    await db
      .update(storeSearchSyncJobs)
      .set({
        status: "completed",
        leaseUntil: null,
        completedAt: syncedAt,
        lastError: null,
        updatedAt: syncedAt,
      })
      .where(
        and(
          eq(storeSearchSyncJobs.sourceId, job.sourceId),
          eq(storeSearchSyncJobs.date, job.date),
          eq(storeSearchSyncJobs.dimension, job.dimension),
        ),
      );
    await db
      .update(storeSearchSources)
      .set({
        lastSyncedAt: syncedAt,
        lastDataDate: sql`greatest(coalesce(${storeSearchSources.lastDataDate}, ${job.date}::date), ${job.date}::date)`,
        lastError: null,
      })
      .where(eq(storeSearchSources.id, job.sourceId));
  });
}

async function failSearchJob(job: ClaimedSearchJob, error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 500);
  await withService(async (db) => {
    await db
      .update(storeSearchSyncJobs)
      .set({
        status: job.attempts >= SEARCH_JOB_MAX_ATTEMPTS ? "failed" : "queued",
        leaseUntil: null,
        lastError: message,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(storeSearchSyncJobs.sourceId, job.sourceId),
          eq(storeSearchSyncJobs.date, job.date),
          eq(storeSearchSyncJobs.dimension, job.dimension),
        ),
      );
    await db
      .update(storeSearchSources)
      .set({ lastError: message })
      .where(eq(storeSearchSources.id, job.sourceId));
  });
  logError("Search Console metric bucket failed", error, {
    sourceId: job.sourceId,
    date: job.date,
    dimension: job.dimension,
  });
}

export interface SearchMetricWorkerResult {
  processed: number;
  remaining: boolean;
  status: "idle" | "completed" | "failed" | "rate_limited";
  sourceId?: string;
  date?: string;
  dimension?: SearchMetricDimension;
}

export async function runSearchMetricWorker(): Promise<SearchMetricWorkerResult> {
  const jobs = await claimSearchJobs();
  const job = jobs[0];
  if (!job) return { processed: 0, remaining: false, status: "idle" };
  const identity = {
    sourceId: job.sourceId,
    date: job.date,
    dimension: job.dimension,
  };
  if (!(await claimRateSlot(job.source.property))) {
    await Promise.all(jobs.map(releaseRateLimitedJob));
    return {
      processed: 0,
      remaining: true,
      status: "rate_limited",
      ...identity,
    };
  }
  try {
    const response = await queryGoogleSearchAnalytics(
      job.source.property,
      requestForJobs(jobs),
    );
    if (response.responseAggregationType !== "byPage") {
      throw new Error(
        `Search Console returned unsafe aggregation: ${response.responseAggregationType ?? "missing"}`,
      );
    }
    if (job.dimension === "total") {
      const rowsByDate = new Map(
        (response.rows ?? []).map((row) => [row.keys?.[0] ?? "", row]),
      );
      for (const totalJob of jobs) {
        const row = rowsByDate.get(totalJob.date);
        await replaceSearchBucket(
          totalJob,
          normalizeSearchRows(row ? [row] : [], "total"),
        );
      }
    } else {
      await replaceSearchBucket(
        job,
        normalizeSearchRows(response.rows, job.dimension),
      );
    }
    logInfo("Search Console metric bucket completed", identity);
    return {
      processed: jobs.length,
      remaining: true,
      status: "completed",
      ...identity,
    };
  } catch (error) {
    await Promise.all(jobs.map((failed) => failSearchJob(failed, error)));
    return {
      processed: jobs.length,
      remaining: true,
      status: "failed",
      ...identity,
    };
  }
}
