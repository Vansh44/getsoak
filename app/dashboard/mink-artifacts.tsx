import {
  ArrowUpRight,
  BookOpen,
  Boxes,
  ChartNoAxesCombined,
} from "lucide-react";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkProposalCard } from "./mink-proposal-card";

export function MinkArtifacts({ artifacts }: { artifacts: MinkArtifact[] }) {
  if (!artifacts.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {artifacts.map((artifact, index) => {
        if (artifact.type === "metrics") {
          return (
            <MetricArtifact
              key={`${artifact.type}-${index}`}
              artifact={artifact}
            />
          );
        }
        if (artifact.type === "records") {
          return (
            <RecordArtifact
              key={`${artifact.type}-${index}`}
              artifact={artifact}
            />
          );
        }
        if (artifact.type === "proposal") {
          return (
            <MinkProposalCard
              key={`${artifact.type}-${artifact.draftId}`}
              proposal={artifact}
            />
          );
        }
        return (
          <SourceArtifact
            key={`${artifact.type}-${index}`}
            artifact={artifact}
          />
        );
      })}
    </div>
  );
}

function Filters({
  filters,
}: {
  filters: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {filters
        .filter((filter) => filter.value)
        .map((filter) => (
          <span
            key={`${filter.label}-${filter.value}`}
            className="rounded-full border border-[#ded8f4] bg-[#faf8ff] px-2 py-1 text-[10px] text-[#5e5179]"
          >
            <span className="font-semibold">{filter.label}:</span>{" "}
            {filter.value}
          </span>
        ))}
    </div>
  );
}

function MetricArtifact({
  artifact,
}: {
  artifact: Extract<MinkArtifact, { type: "metrics" }>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#e4e0ef] bg-white shadow-sm">
      <ArtifactHeader
        title={artifact.title}
        icon={<ChartNoAxesCombined className="h-3.5 w-3.5" />}
        href={artifact.dashboardPath}
      />
      <div className="p-3">
        <Filters filters={artifact.filters} />
        <div className="grid grid-cols-2 gap-2">
          {artifact.metrics.map((metric) => (
            <div key={metric.label} className="rounded-lg bg-[#f7f7f8] p-2.5">
              <div className="text-[10px] font-medium text-[#6d7175]">
                {metric.label}
              </div>
              <div className="mt-0.5 text-base font-semibold text-[#1a1a1a]">
                {formatMetric(metric.value, metric.format, artifact.currency)}
              </div>
              {metric.trendPercent != null ? (
                <div
                  className={`text-[10px] ${metric.trendPercent >= 0 ? "text-emerald-700" : "text-rose-700"}`}
                >
                  {metric.trendPercent >= 0 ? "+" : ""}
                  {metric.trendPercent}% comparison
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <DataAsOf value={artifact.dataAsOf} />
      </div>
    </section>
  );
}

function RecordArtifact({
  artifact,
}: {
  artifact: Extract<MinkArtifact, { type: "records" }>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#e4e0ef] bg-white shadow-sm">
      <ArtifactHeader
        title={artifact.title}
        icon={<Boxes className="h-3.5 w-3.5" />}
        href={artifact.dashboardPath}
      />
      <div className="p-3">
        <Filters filters={artifact.filters} />
        <div className="divide-y divide-[#eeeeef]">
          {artifact.records.slice(0, 10).map((record) => (
            <div
              key={`${artifact.recordType}-${record.id}`}
              className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                {safeHref(record.dashboardPath) ? (
                  <a
                    href={record.dashboardPath}
                    className="block truncate text-xs font-semibold text-[#2f2460] hover:underline"
                  >
                    {record.title}
                  </a>
                ) : (
                  <div className="truncate text-xs font-semibold text-[#2f2460]">
                    {record.title}
                  </div>
                )}
                {record.subtitle ? (
                  <div className="truncate text-[10px] text-[#7b7f86]">
                    {record.subtitle}
                  </div>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                {record.value ? (
                  <div className="text-xs font-semibold text-[#1a1a1a]">
                    {record.value}
                  </div>
                ) : null}
                {record.status ? (
                  <div className="text-[10px] capitalize text-[#7b7f86]">
                    {record.status.replaceAll("_", " ")}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {!artifact.records.length ? (
            <div className="py-3 text-xs text-[#7b7f86]">
              No matching records.
            </div>
          ) : null}
        </div>
        {artifact.truncated ? (
          <div className="mt-2 text-[10px] text-[#7b7f86]">
            Showing the lowest-stock matches. Open the dashboard for the full
            list.
          </div>
        ) : null}
        <DataAsOf value={artifact.dataAsOf} />
      </div>
    </section>
  );
}

function SourceArtifact({
  artifact,
}: {
  artifact: Extract<MinkArtifact, { type: "sources" }>;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#e4e0ef] bg-white shadow-sm">
      <ArtifactHeader
        title={artifact.title}
        icon={<BookOpen className="h-3.5 w-3.5" />}
      />
      <div className="divide-y divide-[#eeeeef] px-3">
        {artifact.sources.map((source) => (
          <a
            key={source.url}
            href={safeHref(source.url) ? source.url : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="block py-2.5 first:pt-3 last:pb-3 hover:bg-[#fbfaff]"
          >
            <div className="flex items-start justify-between gap-2 text-xs font-semibold text-[#2f2460]">
              {source.title}
              <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0" />
            </div>
            {source.excerpt ? (
              <div className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-[#7b7f86]">
                {source.excerpt}
              </div>
            ) : null}
          </a>
        ))}
      </div>
    </section>
  );
}

function ArtifactHeader({
  title,
  icon,
  href,
}: {
  title: string;
  icon: React.ReactNode;
  href?: string;
}) {
  return (
    <header className="flex items-center justify-between border-b border-[#eeeeef] bg-[#fbfaff] px-3 py-2 text-xs font-semibold text-[#3e3262]">
      <span className="flex items-center gap-1.5">
        {icon}
        {title}
      </span>
      {safeHref(href) ? (
        <a
          href={href}
          className="rounded p-1 hover:bg-[#eee9ff]"
          aria-label={`Open ${title}`}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </header>
  );
}

function formatMetric(
  value: number,
  format: "number" | "currency" | "percent",
  currency = "INR",
) {
  if (format === "currency") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (format === "percent") return `${value.toLocaleString("en-IN")}%`;
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function DataAsOf({ value }: { value?: string }) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <div className="mt-2 text-right text-[9px] text-[#9a9da3]">
      Data as of{" "}
      {date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}{" "}
      IST
    </div>
  );
}

function safeHref(value: string | undefined): value is string {
  if (!value) return false;
  if (value.startsWith("/dashboard")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.startsWith("help.");
  } catch {
    return false;
  }
}
