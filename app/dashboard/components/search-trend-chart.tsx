"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SearchTrendPoint } from "../analytics/search-data";

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function SearchTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number;
    color?: string;
  }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="dash-search-tooltip">
      <div className="dash-search-tooltip-label">{label}</div>
      {payload.map((item) => (
        <div key={String(item.dataKey)} className="dash-search-tooltip-value">
          <span style={{ background: item.color }} />
          {item.dataKey === "clicks" ? "Clicks" : "Impressions"}:{" "}
          {(item.value ?? 0).toLocaleString("en-IN")}
        </div>
      ))}
    </div>
  );
}

export function SearchTrendChart({ data }: { data: SearchTrendPoint[] }) {
  return (
    <div className="dash-search-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 10, right: 6, bottom: 0, left: -12 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" axisLine={false} tickLine={false} dy={8} />
          <YAxis
            yAxisId="clicks"
            axisLine={false}
            tickLine={false}
            tickFormatter={compactNumber}
            width={52}
          />
          <YAxis
            yAxisId="impressions"
            orientation="right"
            axisLine={false}
            tickLine={false}
            tickFormatter={compactNumber}
            width={52}
          />
          <Tooltip content={<SearchTooltip />} />
          <Line
            yAxisId="clicks"
            type="monotone"
            dataKey="clicks"
            stroke="var(--dash-accent)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="impressions"
            type="monotone"
            dataKey="impressions"
            stroke="var(--dash-text-3)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
