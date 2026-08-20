import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { getActingStoreId, requireSectionAccess } from "../../../lib/access";
import { AnalyticsFilters } from "../../analytics-filters";
import {
  getAnalyticsLocationOptions,
  getSalesAnalytics,
  getTopProducts,
} from "../../data";
import { getSearchRankingReport } from "../../search-data";
import { getTotalSalesReport } from "../data";
import {
  ANALYTICS_REPORTS,
  analyticsReportCsvHref,
  isAnalyticsReportId,
} from "@/lib/analytics/reports";
import type { AnalyticsSearchParams } from "@/lib/analytics/range";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { resolveAnalyticsLocation } from "@/lib/analytics/location";
import { getViewerLocations } from "@/lib/locations/scope";

const PAGE_ROW_LIMIT = 250;

function money(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function dateTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function EmptyReport() {
  return (
    <div className="px-6 py-16 text-center text-[13px] text-[var(--dash-text-3)]">
      No rows are available for this range.
    </div>
  );
}

export default async function AnalyticsReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<AnalyticsSearchParams>;
}) {
  await requireSectionAccess("analytics", "view");
  const [{ report }, query, storeId, locationScope] = await Promise.all([
    params,
    searchParams,
    getActingStoreId(),
    getViewerLocations(),
  ]);
  if (!isAnalyticsReportId(report)) notFound();

  const timeZone = await getStoreAnalyticsTimeZone(storeId);
  const range = parseAnalyticsRange(query, timeZone);
  const supportsLocation = report !== "search-queries";
  const locationOptions = supportsLocation
    ? await getAnalyticsLocationOptions(storeId, locationScope)
    : [];
  const location = resolveAnalyticsLocation(
    supportsLocation ? query.location : undefined,
    locationScope,
    locationOptions,
  );
  const meta = ANALYTICS_REPORTS[report];

  let rows: React.ReactNode;
  let shown = 0;
  if (report === "total-sales") {
    const data = await getTotalSalesReport(
      storeId,
      location,
      range,
      PAGE_ROW_LIMIT,
    );
    shown = data.length;
    rows = data.length ? (
      <table className="dash-table w-full min-w-[820px]">
        <thead>
          <tr>
            <th>Date</th>
            <th>Event</th>
            <th>Order</th>
            <th>Channel</th>
            <th>Location</th>
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={`${row.event}-${row.id}`}>
              <td>{dateTime(row.occurredAt, range.timeZone)}</td>
              <td>{row.event}</td>
              <td>{row.orderRef}</td>
              <td>{row.channel}</td>
              <td>{row.location}</td>
              <td
                className={`text-right tabular-nums ${row.amount < 0 ? "text-[var(--dash-red)]" : ""}`}
              >
                {money(row.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <EmptyReport />
    );
  } else if (report === "sales-over-time") {
    const data = await getSalesAnalytics(storeId, location, range);
    shown = data.series.length;
    rows = data.series.length ? (
      <table className="dash-table w-full min-w-[640px]">
        <thead>
          <tr>
            <th>Period</th>
            <th className="text-right">Net sales</th>
            <th className="text-right">Orders</th>
            <th className="text-right">Units</th>
          </tr>
        </thead>
        <tbody>
          {data.series.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td className="text-right tabular-nums">{money(row.sales)}</td>
              <td className="text-right tabular-nums">
                {row.orders.toLocaleString("en-IN")}
              </td>
              <td className="text-right tabular-nums">
                {row.units.toLocaleString("en-IN")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <EmptyReport />
    );
  } else if (report === "top-products") {
    const data = await getTopProducts(storeId, location, range, PAGE_ROW_LIMIT);
    shown = data.length;
    rows = data.length ? (
      <table className="dash-table w-full min-w-[640px]">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Product</th>
            <th className="text-right">Units</th>
            <th className="text-right">Merchandise value</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => (
            <tr key={row.id}>
              <td>{index + 1}</td>
              <td>{row.name}</td>
              <td className="text-right tabular-nums">
                {row.units.toLocaleString("en-IN")}
              </td>
              <td className="text-right tabular-nums">{money(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <EmptyReport />
    );
  } else {
    const data = await getSearchRankingReport(
      storeId,
      range,
      "query",
      PAGE_ROW_LIMIT,
    );
    shown = data.length;
    rows = data.length ? (
      <table className="dash-table w-full min-w-[720px]">
        <thead>
          <tr>
            <th>Search term</th>
            <th className="text-right">Clicks</th>
            <th className="text-right">Impressions</th>
            <th className="text-right">CTR</th>
            <th className="text-right">Position</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.key}>
              <td>{row.key}</td>
              <td className="text-right tabular-nums">
                {row.clicks.toLocaleString("en-IN")}
              </td>
              <td className="text-right tabular-nums">
                {row.impressions.toLocaleString("en-IN")}
              </td>
              <td className="text-right tabular-nums">{row.ctr.toFixed(1)}%</td>
              <td className="text-right tabular-nums">
                {row.position.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <EmptyReport />
    );
  }

  return (
    <div className="dash-page-enter dash-analytics flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <Link
            href="/dashboard/analytics"
            className="mb-1 inline-flex items-center gap-1 text-[13px] text-[var(--dash-text-3)] hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Analytics
          </Link>
          <h1>{meta.title}</h1>
          <p>
            {meta.description} · {range.label}
          </p>
        </div>
        <a href={analyticsReportCsvHref(report, query)} className="dash-an-btn">
          <Download className="h-4 w-4" />
          Export CSV
        </a>
      </header>

      <div className="dash-card">
        <div className="dash-card-header flex-wrap gap-3">
          <div>
            <div className="dash-card-title">{meta.source} data</div>
            <div className="dash-card-sub">
              {shown.toLocaleString("en-IN")} rows shown
              {shown === PAGE_ROW_LIMIT
                ? ` · page limited to ${PAGE_ROW_LIMIT.toLocaleString("en-IN")}`
                : ""}
            </div>
          </div>
          <AnalyticsFilters
            range={range}
            locations={locationOptions}
            selectedLocationId={location.selectedId}
          />
        </div>
        <div className="overflow-x-auto">{rows}</div>
        {report === "top-products" ? (
          <p className="px-5 pb-4 text-[12px] text-[var(--dash-text-3)]">
            Merchandise value is before order-level discounts, tax, and refunds.
          </p>
        ) : null}
        {report === "search-queries" ? (
          <p className="px-5 pb-4 text-[12px] text-[var(--dash-text-3)]">
            Google may omit rare searches for privacy. Data usually arrives
            about two days late and uses Pacific Time dates.
          </p>
        ) : null}
      </div>
    </div>
  );
}
