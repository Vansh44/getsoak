import type { ReactNode } from "react";

import { MetricCard } from "../components/metric-card";
import { ActivityFeed } from "../components/activity-feed";
import { RevenueChart } from "../components/revenue-chart-lazy";
import { EnquiriesOverview } from "../components/enquiries-overview";
import { TopCategories } from "../components/top-categories";
import { RecentOrdersTable } from "../components/recent-orders-table";
import { BlogApprovals } from "../components/blog-approvals";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { getAnalyticsData } from "./data";
import { DashboardCanvas } from "./dashboard-canvas";
import type { WidgetId } from "./widgets";
import { getViewerLocations } from "@/lib/locations/scope";

// The store's performance dashboard — metrics, revenue, recent activity, all
// from live store data (scoped by store_id). This used to be the /dashboard
// landing page; it moved here when Home became a Shopify-style getting-started
// page. Gated on the `analytics` section.
//
// Every card is rendered HERE (server-side, with the data already loaded) and
// handed to <DashboardCanvas> as a slot. The canvas decides which slots appear
// and in what order — see widgets.ts. A widget the viewer lacks permission for
// is simply never put in the map, so it can't be added back from the library
// either.
export default async function AnalyticsPage() {
  const access = await requireSectionAccess("analytics", "view");
  const showBlogApprovals = access.can("blogs", "view");
  const showEnquiries = access.can("enquiries", "view");

  const storeId = await getActingStoreId();
  // ★ null for an unrestricted viewer, so the owner's numbers are unchanged.
  const locationScope = await getViewerLocations();
  const data = await getAnalyticsData(storeId, locationScope);

  const slots: Partial<Record<WidgetId, ReactNode>> = {
    metric_revenue: (
      <MetricCard label="Total revenue" stat={data.stats.revenue} currency />
    ),
    metric_orders: (
      <MetricCard label="Orders this month" stat={data.stats.orders} />
    ),
    metric_customers: (
      <MetricCard label="Total customers" stat={data.stats.customers} />
    ),
    metric_products: (
      <MetricCard label="Products listed" stat={data.stats.products} />
    ),
    revenue_chart: (
      <RevenueChart
        series={data.revenueSeries}
        totalRevenue={data.totalRevenue}
        trendPct={data.revenueTrendPct}
        trendUp={data.revenueTrendUp}
      />
    ),
    top_categories: <TopCategories items={data.topCategories} />,
    recent_orders: <RecentOrdersTable orders={data.recentOrders} />,
    activity: <ActivityFeed items={data.activity} />,
  };
  if (showBlogApprovals) slots.blog_approvals = <BlogApprovals />;
  if (showEnquiries) slots.enquiries = <EnquiriesOverview />;

  return (
    <div className="dash-analytics">
      {showBlogApprovals && <RealtimeRefresher tables={["blogs"]} />}
      <DashboardCanvas storeId={storeId} slots={slots} />
    </div>
  );
}
