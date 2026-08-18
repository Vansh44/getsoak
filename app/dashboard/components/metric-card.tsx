import type { Stat } from "../analytics/data";

// A single analytics metric — label, value, change vs last month, and a hairline
// sparkline. Deliberately monochrome: no icon chips, no coloured pills. Colour
// is reserved for the ONE thing that carries meaning here (the trend direction),
// which is what keeps a wall of these readable.

export interface MetricCardProps {
  label: string;
  stat: Stat;
  /** Rupee-format the value (revenue) vs plain count. */
  currency?: boolean;
}

function formatValue(value: number, currency: boolean): string {
  const rounded = Math.round(value);
  const n = rounded.toLocaleString("en-IN");
  return currency ? `₹${n}` : n;
}

function Sparkline({ data }: { data: number[] }) {
  const w = 72;
  const h = 22;
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const line = data
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * (h - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fill="none"
      preserveAspectRatio="none"
      className="dash-metric-spark"
      aria-hidden
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MetricCard({ label, stat, currency = false }: MetricCardProps) {
  // A flat month reads as "—", not "+0%" — Shopify's convention, and it stops
  // an empty store from showing a wall of meaningless green.
  const noComparison = stat.trendPct === null;
  const flat = stat.trendPct === 0;
  const deltaClass =
    noComparison || flat ? "is-flat" : stat.trendUp ? "is-up" : "is-down";

  return (
    <div className="dash-metric">
      <div className="dash-metric-label">{label}</div>
      <div className="dash-metric-row">
        <span className="dash-metric-val">
          {formatValue(stat.value, currency)}
        </span>
        {!noComparison ? (
          <span className={`dash-metric-delta ${deltaClass}`}>
            {flat
              ? "—"
              : `${stat.trendUp ? "↑" : "↓"} ${Math.abs(stat.trendPct ?? 0)}%`}
          </span>
        ) : null}
        <Sparkline data={stat.spark} />
      </div>
    </div>
  );
}
