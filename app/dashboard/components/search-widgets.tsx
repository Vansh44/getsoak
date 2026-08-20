import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type {
  SearchAnalytics,
  SearchAnalyticsState,
  SearchMetricStat,
  SearchRankingRow,
} from "../analytics/search-data";
import { SearchTrendChart } from "./search-trend-chart-lazy";

type SearchMetric = "clicks" | "impressions" | "ctr" | "position";

const METRIC_META: Record<
  SearchMetric,
  { title: string; format: "count" | "percent" | "position" }
> = {
  clicks: { title: "Google Search clicks", format: "count" },
  impressions: { title: "Google Search impressions", format: "count" },
  ctr: { title: "Search click-through rate", format: "percent" },
  position: { title: "Average search position", format: "position" },
};

function formatLastUpdated(value: string | null): string {
  if (!value) return "Waiting for first update";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Waiting for first update";
  return `Updated ${new Intl.DateTimeFormat("en-IN", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)} UTC`;
}

function SearchSourceMeta({ data }: { data: SearchAnalytics }) {
  return (
    <>
      {data.warning ? (
        <div className="dash-search-warning" role="status">
          {data.warning}
        </div>
      ) : null}
      <div className="dash-search-meta">
        <span className="dash-search-source">Google Search</span>
        <span>{formatLastUpdated(data.lastUpdated)}</span>
        <span>Usually ~2 days behind · Pacific Time</span>
      </div>
    </>
  );
}

function SearchState({ state }: { state: SearchAnalyticsState }) {
  if (state === "ready") return null;
  const content = {
    not_launched: {
      title: "Search data starts after launch",
      text: "Publish your store to start collecting Google Search data.",
    },
    collecting: {
      title: "Collecting Search data",
      text: "The first complete Google Search day usually appears in about 2 days.",
    },
    no_visibility: {
      title: "No search visibility yet",
      text: "Google hasn’t shown your store in search yet. We’ll keep checking.",
    },
    error: {
      title: "Google Search needs attention",
      text: "Check your domain verification and Search Console access, then try again.",
    },
  }[state];
  return (
    <div className="dash-search-state">
      <strong>{content.title}</strong>
      <span>{content.text}</span>
      {state === "error" ? (
        <Link href="/dashboard/settings/domain">Open Domain settings</Link>
      ) : null}
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const width = 72;
  const height = 22;
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / range) * (height - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      preserveAspectRatio="none"
      className="dash-metric-spark"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatMetric(
  value: number,
  format: "count" | "percent" | "position",
): string {
  if (format === "count") return Math.round(value).toLocaleString("en-IN");
  if (format === "percent") return `${value.toFixed(1)}%`;
  return value.toFixed(1);
}

function MetricValue({
  stat,
  metric,
}: {
  stat: SearchMetricStat;
  metric: SearchMetric;
}) {
  const meta = METRIC_META[metric];
  const flat = stat.trendPct === 0;
  const deltaClass =
    stat.trendPct === null || flat
      ? "is-flat"
      : stat.improved
        ? "is-up"
        : "is-down";
  return (
    <div className="dash-metric-row">
      <span className="dash-metric-val">
        {formatMetric(stat.value, meta.format)}
      </span>
      {stat.trendPct !== null ? (
        <span className={`dash-metric-delta ${deltaClass}`}>
          {flat
            ? "—"
            : `${stat.direction === "up" ? "↑" : "↓"} ${Math.abs(stat.trendPct)}%`}
        </span>
      ) : null}
      <Sparkline data={stat.spark} />
    </div>
  );
}

export function SearchMetricCard({
  data,
  metric,
}: {
  data: SearchAnalytics;
  metric: SearchMetric;
}) {
  const meta = METRIC_META[metric];
  return (
    <div className="dash-metric dash-search-metric">
      <div className="dash-metric-label">{meta.title}</div>
      {data.state === "ready" ? (
        <MetricValue stat={data[metric]} metric={metric} />
      ) : (
        <SearchState state={data.state} />
      )}
      <SearchSourceMeta data={data} />
    </div>
  );
}

export function SearchTrendWidget({ data }: { data: SearchAnalytics }) {
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">Google Search performance</div>
          <div className="dash-card-sub">{data.rangeLabel}</div>
        </div>
        <div className="dash-search-legend" aria-label="Chart legend">
          <span className="is-clicks">Clicks</span>
          <span className="is-impressions">Impressions</span>
        </div>
      </div>
      <div className="dash-card-body">
        {data.state === "ready" ? (
          <SearchTrendChart data={data.series} />
        ) : (
          <SearchState state={data.state} />
        )}
        <SearchSourceMeta data={data} />
      </div>
    </div>
  );
}

function readablePage(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function RankingTable({
  rows,
  kind,
}: {
  rows: SearchRankingRow[];
  kind: "query" | "page";
}) {
  if (rows.length === 0) {
    return (
      <div className="dash-search-ranking-empty">
        No rows are available for this range. Google may omit rare searches to
        protect user privacy.
      </div>
    );
  }
  return (
    <div className="dash-search-table-wrap">
      <table className="dash-search-table">
        <thead>
          <tr>
            <th>{kind === "query" ? "Search term" : "Landing page"}</th>
            <th>Clicks</th>
            <th>Impr.</th>
            <th>CTR</th>
            <th>Position</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td title={row.key}>
                {kind === "page" ? readablePage(row.key) : row.key}
              </td>
              <td>{row.clicks.toLocaleString("en-IN")}</td>
              <td>{row.impressions.toLocaleString("en-IN")}</td>
              <td>{row.ctr.toFixed(1)}%</td>
              <td>{row.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SearchRankingWidget({
  data,
  kind,
  reportHref,
}: {
  data: SearchAnalytics;
  kind: "query" | "page";
  reportHref?: string;
}) {
  const title =
    kind === "query" ? "Top Google searches" : "Top search landing pages";
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">
            {reportHref ? (
              <Link
                href={reportHref}
                className="inline-flex items-center gap-1 hover:text-[var(--dash-accent)]"
              >
                {title}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : (
              title
            )}
          </div>
          <div className="dash-card-sub">
            {data.rangeLabel} · ranked by clicks
          </div>
        </div>
      </div>
      <div className="dash-card-body">
        {data.state === "ready" ? (
          <RankingTable
            rows={kind === "query" ? data.queries : data.pages}
            kind={kind}
          />
        ) : (
          <SearchState state={data.state} />
        )}
        {data.state === "ready" ? (
          <p className="dash-search-note">
            Rare searches can be omitted, so rows may not add up to total
            impressions.
          </p>
        ) : null}
        <SearchSourceMeta data={data} />
      </div>
    </div>
  );
}
