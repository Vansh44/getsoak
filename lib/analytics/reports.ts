import type { AnalyticsSearchParams } from "./range";

export const ANALYTICS_REPORT_IDS = [
  "total-sales",
  "sales-over-time",
  "top-products",
  "search-queries",
] as const;

export type AnalyticsReportId = (typeof ANALYTICS_REPORT_IDS)[number];

export interface AnalyticsReportMeta {
  id: AnalyticsReportId;
  title: string;
  description: string;
  source: "StoreMink" | "Google Search";
}

export const ANALYTICS_REPORTS: Record<AnalyticsReportId, AnalyticsReportMeta> =
  {
    "total-sales": {
      id: "total-sales",
      title: "Total sales",
      description:
        "Recognized sale and completed refund events that make up net sales.",
      source: "StoreMink",
    },
    "sales-over-time": {
      id: "sales-over-time",
      title: "Sales over time",
      description:
        "Net sales, recognized orders, and units by reporting period.",
      source: "StoreMink",
    },
    "top-products": {
      id: "top-products",
      title: "Product sales",
      description: "Products ranked by units sold and merchandise value.",
      source: "StoreMink",
    },
    "search-queries": {
      id: "search-queries",
      title: "Google Search queries",
      description:
        "Search terms ranked by clicks, with impressions, CTR, and position.",
      source: "Google Search",
    },
  };

export const MAX_ANALYTICS_REPORT_ROWS = 10_000;

const REPORT_PARAM_KEYS = [
  "range",
  "compare",
  "from",
  "to",
  "compareFrom",
  "compareTo",
  "location",
] as const;

export function isAnalyticsReportId(
  value: unknown,
): value is AnalyticsReportId {
  return (
    typeof value === "string" &&
    (ANALYTICS_REPORT_IDS as readonly string[]).includes(value)
  );
}

export function analyticsReportQuery(
  params: AnalyticsSearchParams,
  options: { omitLocation?: boolean } = {},
): string {
  const query = new URLSearchParams();
  for (const key of REPORT_PARAM_KEYS) {
    if (options.omitLocation && key === "location") continue;
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) query.set(key, value);
  }
  return query.toString();
}

export function analyticsReportHref(
  report: AnalyticsReportId,
  params: AnalyticsSearchParams,
): string {
  const query = analyticsReportQuery(params, {
    omitLocation: report === "search-queries",
  });
  const path = `/dashboard/analytics/reports/${report}`;
  return query ? `${path}?${query}` : path;
}

export function analyticsReportCsvHref(
  report: AnalyticsReportId,
  params: AnalyticsSearchParams,
): string {
  const query = analyticsReportQuery(params, {
    omitLocation: report === "search-queries",
  });
  const path = `/api/dashboard/analytics/reports/${report}`;
  return query ? `${path}?${query}` : path;
}
