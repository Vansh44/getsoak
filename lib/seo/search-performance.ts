/** Pure Google Search Console request/row rules. Database and auth stay in the
 * server-only search-metrics module so these invariants can be tested directly. */

export const SEARCH_TIME_ZONE = "America/Los_Angeles";
export const SEARCH_CORRECTION_DAYS = 5;
export const SEARCH_DATA_LAG_DAYS = 2;
export const SEARCH_RETENTION_DAYS = 488;

export const SEARCH_DIMENSION_LIMITS = {
  total: 1,
  query: 25,
  page: 25,
  country: 10,
  device: 3,
} as const;

export type SearchMetricDimension = keyof typeof SEARCH_DIMENSION_LIMITS;
export type SearchSourceKind = "platform_subdomain" | "custom_domain";

export interface SearchDimensionFilter {
  dimension: "page";
  operator: "includingRegex";
  expression: string;
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  position?: number;
}

export interface StoredSearchMetric {
  key: string;
  clicks: number;
  impressions: number;
  positionSum: string;
}

export function normalizeSearchOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "https:")
    throw new Error("Search origin must use HTTPS");
  if (
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Search origin must be an HTTPS origin without a path");
  }
  return `https://${url.hostname.toLowerCase()}`;
}

function escapeRe2(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** An anchored host filter is the tenant boundary for the shared Domain
 * property. `contains` would let `mink` match `supermink.storemink.com`. */
export function pageFilterForOrigin(origin: string): SearchDimensionFilter {
  const host = new URL(normalizeSearchOrigin(origin)).host;
  return {
    dimension: "page",
    operator: "includingRegex",
    expression: `^https://${escapeRe2(host)}/`,
  };
}

export function addSearchDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()))
    throw new Error("Invalid search date");
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export function pacificDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SEARCH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Five final-data PT days, oldest first. Today and yesterday are deliberately
 * excluded because Search Console normally has not completed them yet. */
export function correctionDates(now: Date = new Date()): string[] {
  const latest = addSearchDays(pacificDate(now), -SEARCH_DATA_LAG_DAYS);
  return Array.from({ length: SEARCH_CORRECTION_DAYS }, (_, index) =>
    addSearchDays(latest, index - SEARCH_CORRECTION_DAYS + 1),
  );
}

export function mondayForSearchDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  const offset = (instant.getUTCDay() + 6) % 7;
  return addSearchDays(date, -offset);
}

export function normalizeSearchRows(
  rows: SearchAnalyticsRow[] | undefined,
  dimension: SearchMetricDimension,
): StoredSearchMetric[] {
  return (rows ?? [])
    .slice(0, SEARCH_DIMENSION_LIMITS[dimension])
    .map((row) => {
      const clicks = Math.max(0, Math.round(row.clicks ?? 0));
      const impressions = Math.max(0, Math.round(row.impressions ?? 0));
      const position = Number.isFinite(row.position) ? (row.position ?? 0) : 0;
      return {
        key: dimension === "total" ? "" : (row.keys?.at(-1) ?? ""),
        clicks,
        impressions,
        // Keep decimal arithmetic out of JavaScript aggregation. Postgres stores
        // this weighted numerator and dashboard reads divide by impressions.
        positionSum: (position * impressions).toFixed(4),
      };
    });
}
