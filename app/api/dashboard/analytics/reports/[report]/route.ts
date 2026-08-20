import { NextResponse } from "next/server";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import {
  getAnalyticsLocationOptions,
  getSalesAnalytics,
  getTopProducts,
} from "@/app/dashboard/analytics/data";
import { getSearchRankingReport } from "@/app/dashboard/analytics/search-data";
import { getTotalSalesReport } from "@/app/dashboard/analytics/reports/data";
import {
  ANALYTICS_REPORTS,
  MAX_ANALYTICS_REPORT_ROWS,
  isAnalyticsReportId,
} from "@/lib/analytics/reports";
import { resolveAnalyticsLocation } from "@/lib/analytics/location";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { serializeCsv } from "@/lib/csv/serialize";
import { getViewerLocations } from "@/lib/locations/scope";
import { rateLimit } from "@/lib/rate-limit";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ report: string }> },
) {
  const { report } = await params;
  if (!isAnalyticsReportId(report)) {
    return NextResponse.json(
      { error: "Unknown analytics report." },
      { status: 404 },
    );
  }

  const ctx = await getViewerContext();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (ctx.dbError) {
    return NextResponse.json(
      { error: "Can't check your permissions right now. Try again shortly." },
      { status: 503 },
    );
  }
  if (!can(ctx.permissions, "analytics", "view", ctx.isSuperadmin)) {
    return NextResponse.json(
      { error: "You don't have permission to export analytics." },
      { status: 403 },
    );
  }

  const features = await getPlatformAnalyticsFeatures();
  if (!features.coreDashboard || !features.drilldownReports) {
    return NextResponse.json(
      { error: "Analytics reports are currently disabled." },
      { status: 403 },
    );
  }
  if (report === "search-queries" && !features.googleSearchConsole) {
    return NextResponse.json(
      { error: "Google Search analytics is currently disabled." },
      { status: 403 },
    );
  }

  const limit = await rateLimit(`analytics-export:${ctx.storeId}`, {
    max: 30,
    windowSeconds: 3600,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "That's a lot of exports in one hour. Try again shortly." },
      { status: 429 },
    );
  }

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const timeZone = await getStoreAnalyticsTimeZone(ctx.storeId);
  const range = parseAnalyticsRange(query, timeZone);
  const locationScope = await getViewerLocations();
  const supportsLocation = report !== "search-queries";
  const locationOptions = supportsLocation
    ? await getAnalyticsLocationOptions(ctx.storeId, locationScope)
    : [];
  const location = resolveAnalyticsLocation(
    supportsLocation ? query.location : undefined,
    locationScope,
    locationOptions,
  );

  let header: string[];
  let rows: unknown[][];
  if (report === "total-sales") {
    const data = await getTotalSalesReport(
      ctx.storeId,
      location,
      range,
      MAX_ANALYTICS_REPORT_ROWS,
    );
    header = ["Date", "Event", "Order", "Channel", "Location", "Amount"];
    rows = data.map((row) => [
      row.occurredAt,
      row.event,
      row.orderRef,
      row.channel,
      row.location,
      row.amount,
    ]);
  } else if (report === "sales-over-time") {
    const data = await getSalesAnalytics(ctx.storeId, location, range);
    header = ["Period start", "Period label", "Net sales", "Orders", "Units"];
    rows = data.series.map((row) => [
      row.key,
      row.label,
      row.sales,
      row.orders,
      row.units,
    ]);
  } else if (report === "top-products") {
    const data = await getTopProducts(
      ctx.storeId,
      location,
      range,
      MAX_ANALYTICS_REPORT_ROWS,
    );
    header = ["Rank", "Product", "Units", "Merchandise value"];
    rows = data.map((row, index) => [
      index + 1,
      row.name,
      row.units,
      row.amount,
    ]);
  } else {
    const data = await getSearchRankingReport(
      ctx.storeId,
      range,
      "query",
      MAX_ANALYTICS_REPORT_ROWS,
    );
    header = ["Search term", "Clicks", "Impressions", "CTR (%)", "Position"];
    rows = data.map((row) => [
      row.key,
      row.clicks,
      row.impressions,
      row.ctr,
      row.position,
    ]);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${report}-${stamp}.csv`;
  return new NextResponse(serializeCsv(header, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "X-Analytics-Report": ANALYTICS_REPORTS[report].title,
    },
  });
}
