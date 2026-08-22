import "server-only";

import { and, asc, desc, eq, gte, lte, ne, sql } from "drizzle-orm";
import {
  storeSearchMetrics,
  storeSearchSources,
  stores,
} from "@/drizzle/schema";
import type { AnalyticsRange, AnalyticsWindow } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import { pacificDate } from "@/lib/seo/search-performance";

export type SearchAnalyticsState =
  | "not_launched"
  | "collecting"
  | "no_visibility"
  | "ready"
  | "error";

export interface SearchMetricStat {
  value: number;
  trendPct: number | null;
  direction: "up" | "down" | "flat";
  improved: boolean | null;
  spark: number[];
}

export interface SearchTrendPoint {
  date: string;
  label: string;
  clicks: number;
  impressions: number;
}

export interface SearchRankingRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalytics {
  state: SearchAnalyticsState;
  warning: string | null;
  lastUpdated: string | null;
  rangeLabel: string;
  comparisonLabel: string | null;
  clicks: SearchMetricStat;
  impressions: SearchMetricStat;
  ctr: SearchMetricStat;
  position: SearchMetricStat;
  series: SearchTrendPoint[];
  queries: SearchRankingRow[];
  pages: SearchRankingRow[];
}

export interface SearchDateWindow {
  from: string;
  to: string;
}

interface TotalRow {
  date: string;
  clicks: number;
  impressions: number;
  positionSum: number;
}

interface RankingAggregate {
  key: string;
  clicks: number;
  impressions: number;
  positionSum: number;
}

export function searchDateWindow(window: AnalyticsWindow): SearchDateWindow {
  return {
    from: pacificDate(window.from),
    to: pacificDate(new Date(window.to.getTime() - 1)),
  };
}

function searchDateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function searchRangeLabel(window: SearchDateWindow): string {
  const from = searchDateLabel(window.from);
  const to = searchDateLabel(window.to);
  return from === to ? from : `${from} – ${to}`;
}

function sumTotals(rows: readonly TotalRow[]) {
  return rows.reduce(
    (total, row) => ({
      clicks: total.clicks + row.clicks,
      impressions: total.impressions + row.impressions,
      positionSum: total.positionSum + row.positionSum,
    }),
    { clicks: 0, impressions: 0, positionSum: 0 },
  );
}

export function searchMetricStat(
  value: number,
  previous: number | null,
  spark: number[],
  lowerIsBetter = false,
): SearchMetricStat {
  const change = previous === null ? null : value - previous;
  const direction =
    change === null || change === 0 ? "flat" : change > 0 ? "up" : "down";
  return {
    value,
    trendPct:
      previous === null || previous === 0
        ? null
        : Math.round(((value - previous) / previous) * 1_000) / 10,
    direction,
    improved:
      change === null || change === 0
        ? null
        : lowerIsBetter
          ? change < 0
          : change > 0,
    spark,
  };
}

export function deriveSearchState(input: {
  launched: boolean;
  completeDays: number;
  impressions: number;
  error: boolean;
}): SearchAnalyticsState {
  if (!input.launched) return "not_launched";
  if (input.completeDays === 0) return input.error ? "error" : "collecting";
  return input.impressions > 0 ? "ready" : "no_visibility";
}

export function toSearchRanking(
  rows: readonly RankingAggregate[],
): SearchRankingRow[] {
  return rows.map((row) => ({
    key: row.key,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
    position: row.impressions > 0 ? row.positionSum / row.impressions : 0,
  }));
}

function latestTimestamp(values: Array<string | null>): string | null {
  return values.reduce<string | null>(
    (latest, value) => (!value || (latest && latest >= value) ? latest : value),
    null,
  );
}

function isStale(lastUpdated: string | null, now: Date): boolean {
  if (!lastUpdated) return false;
  const refreshedAt = new Date(lastUpdated).getTime();
  return (
    Number.isFinite(refreshedAt) &&
    now.getTime() - refreshedAt > 72 * 60 * 60 * 1_000
  );
}

async function totalRows(
  db: Parameters<Parameters<typeof withService>[0]>[0],
  storeId: string,
  window: SearchDateWindow,
): Promise<TotalRow[]> {
  return db
    .select({
      date: storeSearchMetrics.date,
      clicks:
        sql<number>`coalesce(sum(${storeSearchMetrics.clicks}), 0)::double precision`.mapWith(
          Number,
        ),
      impressions:
        sql<number>`coalesce(sum(${storeSearchMetrics.impressions}), 0)::double precision`.mapWith(
          Number,
        ),
      positionSum:
        sql<number>`coalesce(sum(${storeSearchMetrics.positionSum}), 0)::double precision`.mapWith(
          Number,
        ),
    })
    .from(storeSearchMetrics)
    .where(
      and(
        eq(storeSearchMetrics.storeId, storeId),
        eq(storeSearchMetrics.dimension, "total"),
        gte(storeSearchMetrics.date, window.from),
        lte(storeSearchMetrics.date, window.to),
      ),
    )
    .groupBy(storeSearchMetrics.date)
    .orderBy(asc(storeSearchMetrics.date));
}

async function rankingRows(
  db: Parameters<Parameters<typeof withService>[0]>[0],
  storeId: string,
  window: SearchDateWindow,
  dimension: "query" | "page",
  limit = 25,
): Promise<RankingAggregate[]> {
  return db
    .select({
      key: storeSearchMetrics.key,
      clicks:
        sql<number>`coalesce(sum(${storeSearchMetrics.clicks}), 0)::double precision`.mapWith(
          Number,
        ),
      impressions:
        sql<number>`coalesce(sum(${storeSearchMetrics.impressions}), 0)::double precision`.mapWith(
          Number,
        ),
      positionSum:
        sql<number>`coalesce(sum(${storeSearchMetrics.positionSum}), 0)::double precision`.mapWith(
          Number,
        ),
    })
    .from(storeSearchMetrics)
    .where(
      and(
        eq(storeSearchMetrics.storeId, storeId),
        eq(storeSearchMetrics.dimension, dimension),
        ne(storeSearchMetrics.key, ""),
        gte(storeSearchMetrics.date, window.from),
        lte(storeSearchMetrics.date, window.to),
      ),
    )
    .groupBy(storeSearchMetrics.key)
    .orderBy(
      desc(sql`sum(${storeSearchMetrics.clicks})`),
      desc(sql`sum(${storeSearchMetrics.impressions})`),
    )
    .limit(Math.max(1, Math.min(limit, 10_000)));
}

/** Detailed reports and CSV use the same tenant-bound aggregate as the card,
 * with a larger but still bounded row cap. */
export async function getSearchRankingReport(
  storeId: string,
  range: AnalyticsRange,
  dimension: "query" | "page",
  limit: number,
): Promise<SearchRankingRow[]> {
  const window = searchDateWindow(range.current);
  const rows = await withService((db) =>
    rankingRows(db, storeId, window, dimension, limit),
  );
  return toSearchRanking(rows);
}

/** Read one tenant's delayed Search Console snapshot. Every service-role query
 * includes store_id; source epochs are summed only after that boundary. */
export async function getSearchAnalytics(
  storeId: string,
  range: AnalyticsRange,
  now: Date = new Date(),
): Promise<SearchAnalytics> {
  const currentWindow = searchDateWindow(range.current);
  const compareWindow = range.compare ? searchDateWindow(range.compare) : null;

  const result = await withService(async (db) => {
    const [store] = await db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const sources = await db
      .select({
        inactiveAt: storeSearchSources.inactiveAt,
        lastSyncedAt: storeSearchSources.lastSyncedAt,
        lastError: storeSearchSources.lastError,
      })
      .from(storeSearchSources)
      .where(eq(storeSearchSources.storeId, storeId));
    const current = await totalRows(db, storeId, currentWindow);
    const previous = compareWindow
      ? await totalRows(db, storeId, compareWindow)
      : [];
    const queries = await rankingRows(db, storeId, currentWindow, "query");
    const pages = await rankingRows(db, storeId, currentWindow, "page");
    return { store, sources, current, previous, queries, pages };
  });

  const settings = (result.store?.settings ?? {}) as Record<string, unknown>;
  const launched = settings.launched !== false && settings.demo !== true;
  const activeSource = result.sources.find(
    (source) => source.inactiveAt === null,
  );
  const sourceError = Boolean(activeSource?.lastError);
  const current = sumTotals(result.current);
  const previous = range.compare ? sumTotals(result.previous) : null;
  const currentCtr =
    current.impressions > 0 ? (current.clicks / current.impressions) * 100 : 0;
  const previousCtr =
    previous && previous.impressions > 0
      ? (previous.clicks / previous.impressions) * 100
      : range.compare
        ? 0
        : null;
  const currentPosition =
    current.impressions > 0 ? current.positionSum / current.impressions : 0;
  const previousPosition =
    previous && previous.impressions > 0
      ? previous.positionSum / previous.impressions
      : range.compare
        ? 0
        : null;
  const state = deriveSearchState({
    launched,
    completeDays: result.current.length,
    impressions: current.impressions,
    error: sourceError,
  });
  const lastUpdated = latestTimestamp(
    result.sources.map((source) => source.lastSyncedAt),
  );
  const warning =
    result.current.length > 0 && sourceError
      ? "Google Search could not refresh recently. Showing the last successful snapshot."
      : result.current.length > 0 && isStale(lastUpdated, now)
        ? "This snapshot is older than expected. Showing the last successful data."
        : null;

  return {
    state,
    warning,
    lastUpdated,
    rangeLabel: searchRangeLabel(currentWindow),
    comparisonLabel: compareWindow ? searchRangeLabel(compareWindow) : null,
    clicks: searchMetricStat(
      current.clicks,
      previous?.clicks ?? null,
      result.current.map((row) => row.clicks),
    ),
    impressions: searchMetricStat(
      current.impressions,
      previous?.impressions ?? null,
      result.current.map((row) => row.impressions),
    ),
    ctr: searchMetricStat(
      currentCtr,
      previousCtr,
      result.current.map((row) =>
        row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0,
      ),
    ),
    position: searchMetricStat(
      currentPosition,
      previousPosition,
      result.current.map((row) =>
        row.impressions > 0 ? row.positionSum / row.impressions : 0,
      ),
      true,
    ),
    series: result.current.map((row) => ({
      date: row.date,
      label: searchDateLabel(row.date),
      clicks: row.clicks,
      impressions: row.impressions,
    })),
    queries: toSearchRanking(result.queries),
    pages: toSearchRanking(result.pages),
  };
}
