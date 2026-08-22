"use client";
import Link from "next/link";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowUpRight } from "lucide-react";

import type { SalesPoint, Stat } from "../analytics/data";

export interface RevenueChartProps {
  data: SalesPoint[];
  total: Stat;
  rangeLabel: string;
  comparisonLabel: string | null;
  reportHref?: string;
}

function compactCurrency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    currencyDisplay: "narrowSymbol",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-[10px] border border-[var(--dash-border-strong)] bg-[var(--dash-surface)] px-3 py-2 shadow-[var(--dash-shadow-lg)]">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--dash-text-3)]">
        {label}
      </div>
      <div className="font-mono-dash text-[15px] font-semibold text-[var(--dash-text)]">
        ₹
        {payload[0].value.toLocaleString("en-IN", {
          maximumFractionDigits: 2,
        })}
      </div>
    </div>
  );
}

export function RevenueChart({
  data,
  total,
  rangeLabel,
  comparisonLabel,
  reportHref,
}: RevenueChartProps) {
  const hasData = data.some((point) => point.sales !== 0);

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
                Total sales over time
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            ) : (
              "Total sales over time"
            )}
          </div>
          <div className="dash-card-sub">{rangeLabel}</div>
        </div>
      </div>
      <div className="dash-card-body">
        <div className="mb-4 flex items-end gap-2.5">
          <div className="text-[24px] font-semibold leading-none tracking-[-0.5px] tabular-nums text-[var(--dash-text)]">
            ₹{Math.round(total.value).toLocaleString("en-IN")}
          </div>
          {total.trendPct !== null && comparisonLabel ? (
            <>
              <span
                className={`mb-0.5 text-[12.5px] font-medium tabular-nums ${
                  total.trendPct === 0
                    ? "text-[var(--dash-text-3)]"
                    : total.trendUp
                      ? "text-[var(--dash-green)]"
                      : "text-[var(--dash-red)]"
                }`}
              >
                {total.trendPct === 0
                  ? "—"
                  : `${total.trendUp ? "↑" : "↓"} ${Math.abs(total.trendPct)}%`}
              </span>
              <span className="mb-0.5 text-[12.5px] text-[var(--dash-text-3)]">
                vs {comparisonLabel}
              </span>
            </>
          ) : null}
        </div>
        <div className="relative h-[260px] w-full">
          {!hasData && (
            <div className="absolute inset-0 z-[1] flex items-center justify-center">
              <span className="text-[13px] text-[var(--dash-text-3)]">
                No recognized sales in this range.
              </span>
            </div>
          )}
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
            >
              <defs>
                <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--dash-accent)"
                    stopOpacity={0.14}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--dash-accent)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="0" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} dy={8} />
              <YAxis
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={compactCurrency}
              />
              <Tooltip
                content={<CustomTooltip />}
                cursor={{
                  stroke: "var(--dash-border-hover)",
                  strokeWidth: 1,
                }}
              />
              <Area
                type="monotone"
                dataKey="sales"
                stroke="var(--dash-accent)"
                strokeWidth={2}
                fill="url(#revFill)"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "var(--dash-accent)",
                  stroke: "var(--dash-surface)",
                  strokeWidth: 2,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
