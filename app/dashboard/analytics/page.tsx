import { Suspense, type ReactNode } from "react";
import { ActivityFeed } from "../components/activity-feed";
import { BlogApprovals } from "../components/blog-approvals";
import { EnquiriesOverview } from "../components/enquiries-overview";
import { MetricCard } from "../components/metric-card";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { RecentOrdersTable } from "../components/recent-orders-table";
import { RevenueChart } from "../components/revenue-chart-lazy";
import { TopCategories } from "../components/top-categories";
import { getActingStoreId, requireSectionAccess } from "../lib/access";
import { AnalyticsFilters } from "./analytics-filters";
import { DashboardCanvas } from "./dashboard-canvas";
import {
  getActivity,
  getCatalogSnapshots,
  getRecentOrders,
  getSalesAnalytics,
  getTopCategories,
} from "./data";
import type { CatalogSnapshots, SalesAnalytics } from "./data";
import { isWidgetId, type WidgetId } from "./widgets";
import {
  parseAnalyticsRange,
  type AnalyticsRange,
  type AnalyticsSearchParams,
} from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { getAnalyticsDashboardLayout } from "@/lib/analytics/layout-store";
import { getViewerLocations } from "@/lib/locations/scope";

function WidgetSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`dash-widget-skeleton${compact ? " is-compact" : ""}`}
      aria-label="Loading analytics"
    />
  );
}

async function SalesMetric({
  data,
  metric,
}: {
  data: Promise<SalesAnalytics>;
  metric: "sales" | "orders";
}) {
  const result = await data;
  return metric === "sales" ? (
    <MetricCard label="Total sales" stat={result.totalSales} currency />
  ) : (
    <MetricCard label="Orders" stat={result.orders} />
  );
}

async function SnapshotMetric({
  data,
  metric,
}: {
  data: Promise<CatalogSnapshots>;
  metric: "customers" | "products";
}) {
  const result = await data;
  return metric === "customers" ? (
    <MetricCard label="Total customers" stat={result.customers} />
  ) : (
    <MetricCard label="Products listed" stat={result.products} />
  );
}

async function SalesChart({ data }: { data: Promise<SalesAnalytics> }) {
  const result = await data;
  return (
    <RevenueChart
      data={result.series}
      total={result.totalSales}
      rangeLabel={result.rangeLabel}
      comparisonLabel={result.comparisonLabel}
    />
  );
}

async function CategoryWidget({
  data,
}: {
  data: ReturnType<typeof getTopCategories>;
}) {
  return <TopCategories items={await data} />;
}

async function RecentOrdersWidget({
  data,
}: {
  data: ReturnType<typeof getRecentOrders>;
}) {
  return <RecentOrdersTable orders={await data} />;
}

async function ActivityWidget({
  data,
}: {
  data: ReturnType<typeof getActivity>;
}) {
  return <ActivityFeed items={await data} />;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsSearchParams>;
}) {
  const access = await requireSectionAccess("analytics", "view");
  const showBlogApprovals = access.can("blogs", "view");
  const showEnquiries = access.can("enquiries", "view");
  const [storeId, locationScope, params] = await Promise.all([
    getActingStoreId(),
    getViewerLocations(),
    searchParams,
  ]);
  const timeZone = await getStoreAnalyticsTimeZone(storeId);
  const range: AnalyticsRange = parseAnalyticsRange(params, timeZone);

  // Start every independent data source together. Each slot awaits only its own
  // promise under Suspense, so a slow activity query cannot hold sales cards.
  const sales = getSalesAnalytics(storeId, locationScope, range);
  const catalog = getCatalogSnapshots(storeId);
  const categories = getTopCategories(storeId, locationScope, range);
  const recentOrders = getRecentOrders(storeId, locationScope, range);
  const activity = getActivity(storeId, locationScope, range);

  const slots: Partial<Record<WidgetId, ReactNode>> = {
    metric_revenue: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="sales" />
      </Suspense>
    ),
    metric_orders: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="orders" />
      </Suspense>
    ),
    metric_products: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SnapshotMetric data={catalog} metric="products" />
      </Suspense>
    ),
    revenue_chart: (
      <Suspense fallback={<WidgetSkeleton />}>
        <SalesChart data={sales} />
      </Suspense>
    ),
    top_categories: (
      <Suspense fallback={<WidgetSkeleton />}>
        <CategoryWidget data={categories} />
      </Suspense>
    ),
    recent_orders: (
      <Suspense fallback={<WidgetSkeleton />}>
        <RecentOrdersWidget data={recentOrders} />
      </Suspense>
    ),
    activity: (
      <Suspense fallback={<WidgetSkeleton />}>
        <ActivityWidget data={activity} />
      </Suspense>
    ),
  };
  if (locationScope === null) {
    slots.metric_customers = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SnapshotMetric data={catalog} metric="customers" />
      </Suspense>
    );
  }
  if (showBlogApprovals) {
    slots.blog_approvals = (
      <Suspense fallback={<WidgetSkeleton />}>
        <BlogApprovals />
      </Suspense>
    );
  }
  if (showEnquiries) {
    slots.enquiries = (
      <Suspense fallback={<WidgetSkeleton />}>
        <EnquiriesOverview />
      </Suspense>
    );
  }

  const allowedWidgetIds = Object.keys(slots).filter(isWidgetId);
  const initialLayout = await getAnalyticsDashboardLayout(
    storeId,
    access.userId,
    allowedWidgetIds,
  );

  return (
    <div className="dash-analytics">
      {showBlogApprovals ? <RealtimeRefresher tables={["blogs"]} /> : null}
      <DashboardCanvas
        storeId={storeId}
        slots={slots}
        headerExtras={<AnalyticsFilters range={range} />}
        initialLayout={initialLayout}
      />
    </div>
  );
}
