import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { ActivityFeed } from "../components/activity-feed";
import { AnalyticsSummaryCard } from "../components/analytics-summary-card";
import { BlogApprovals } from "../components/blog-approvals";
import { CommerceBreakdown } from "../components/commerce-breakdown";
import { EnquiriesOverview } from "../components/enquiries-overview";
import { InventoryVelocity } from "../components/inventory-velocity";
import { MetricCard } from "../components/metric-card";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { RecentOrdersTable } from "../components/recent-orders-table";
import { RevenueChart } from "../components/revenue-chart-lazy";
import {
  SearchMetricCard,
  SearchRankingWidget,
  SearchTrendWidget,
} from "../components/search-widgets";
import { TopCategories } from "../components/top-categories";
import { TopProducts } from "../components/top-products";
import { getActingStoreId, requireSectionAccess } from "../lib/access";
import { AnalyticsFilters } from "./analytics-filters";
import { DashboardCanvas } from "./dashboard-canvas";
import {
  getActivity,
  getAnalyticsLocationOptions,
  getCatalogSnapshots,
  getCustomerMix,
  getDiscountImpact,
  getInventoryVelocity,
  getGrossMarginAnalytics,
  getRecentOrders,
  getReturnsAndRefunds,
  getSalesAnalytics,
  getSalesByChannel,
  getSalesByLocation,
  getSalesByPaymentMethod,
  getTopCategories,
  getTopProducts,
} from "./data";
import type { CatalogSnapshots, SalesAnalytics } from "./data";
import type { GrossMarginAnalytics } from "./data";
import { getSearchAnalytics, type SearchAnalytics } from "./search-data";
import { isWidgetId, type WidgetId } from "./widgets";
import {
  parseAnalyticsRange,
  type AnalyticsRange,
  type AnalyticsSearchParams,
} from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { getAnalyticsDashboardLayout } from "@/lib/analytics/layout-store";
import { resolveAnalyticsLocation } from "@/lib/analytics/location";
import { analyticsReportHref } from "@/lib/analytics/reports";
import { getViewerLocations } from "@/lib/locations/scope";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { analyticsFeatureAllowed } from "@/lib/analytics/features";
import { getStorePlanContext } from "@/lib/plans/entitlements";
import {
  getStorefrontAnalytics,
  type StorefrontAnalytics,
} from "./storefront-data";

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
  reportHref,
}: {
  data: Promise<SalesAnalytics>;
  metric: "sales" | "orders" | "aov" | "units";
  reportHref?: string;
}) {
  const result = await data;
  if (metric === "sales")
    return (
      <MetricCard
        label="Total sales"
        stat={result.totalSales}
        currency
        reportHref={reportHref}
      />
    );
  if (metric === "orders")
    return <MetricCard label="Orders" stat={result.orders} />;
  if (metric === "aov")
    return (
      <MetricCard
        label="Average order value"
        stat={result.averageOrderValue}
        currency
      />
    );
  return <MetricCard label="Units sold" stat={result.unitsSold} />;
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

async function SalesChart({
  data,
  reportHref,
}: {
  data: Promise<SalesAnalytics>;
  reportHref?: string;
}) {
  const result = await data;
  return (
    <RevenueChart
      data={result.series}
      total={result.totalSales}
      rangeLabel={result.rangeLabel}
      comparisonLabel={result.comparisonLabel}
      reportHref={reportHref}
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

async function TopProductsWidget({
  data,
  reportHref,
}: {
  data: ReturnType<typeof getTopProducts>;
  reportHref?: string;
}) {
  return <TopProducts items={await data} reportHref={reportHref} />;
}

async function BreakdownWidget({
  data,
  title,
  subtitle,
}: {
  data: ReturnType<typeof getSalesByChannel>;
  title: string;
  subtitle: string;
}) {
  return (
    <CommerceBreakdown items={await data} title={title} subtitle={subtitle} />
  );
}

async function CustomerMixWidget({
  data,
}: {
  data: ReturnType<typeof getCustomerMix>;
}) {
  const result = await data;
  const newShare =
    result.totalCustomers > 0
      ? (result.newCustomers / result.totalCustomers) * 100
      : 0;
  return (
    <AnalyticsSummaryCard
      title="New vs returning customers"
      subtitle="Customers with a recognized order in this range"
      items={[
        { label: "New customers", value: result.newCustomers },
        { label: "Returning customers", value: result.returningCustomers },
        { label: "New-customer share", value: newShare, format: "percent" },
      ]}
      note="Guest orders without a customer account are excluded."
    />
  );
}

async function DiscountWidget({
  data,
}: {
  data: ReturnType<typeof getDiscountImpact>;
}) {
  const result = await data;
  return (
    <AnalyticsSummaryCard
      title="Discount impact"
      subtitle="Markdowns on recognized orders"
      items={[
        {
          label: "Total discounts",
          value: result.totalDiscounts,
          format: "currency",
        },
        {
          label: "Order discounts",
          value: result.orderDiscounts,
          format: "currency",
        },
        {
          label: "Line discounts",
          value: result.lineDiscounts,
          format: "currency",
        },
        { label: "Coupon orders", value: result.couponOrders },
      ]}
    />
  );
}

async function ReturnsWidget({
  data,
  sales,
}: {
  data: ReturnType<typeof getReturnsAndRefunds>;
  sales: Promise<SalesAnalytics>;
}) {
  const [result, salesResult] = await Promise.all([data, sales]);
  const beforeRefunds = salesResult.totalSales.value + result.completedRefunds;
  const refundShare =
    beforeRefunds > 0 ? (result.completedRefunds / beforeRefunds) * 100 : 0;
  const returnedUnitShare =
    salesResult.unitsSold.value > 0
      ? (result.returnedUnits / salesResult.unitsSold.value) * 100
      : 0;
  return (
    <AnalyticsSummaryCard
      title="Returns and refunds"
      subtitle="Completed events in this range"
      items={[
        { label: "Completed returns", value: result.completedReturns },
        { label: "Returned units", value: result.returnedUnits },
        {
          label: "Returned value",
          value: result.returnedValue,
          format: "currency",
        },
        {
          label: "Settled refunds",
          value: result.completedRefunds,
          format: "currency",
        },
        {
          label: "Returned-unit share",
          value: returnedUnitShare,
          format: "percent",
        },
        { label: "Refund share", value: refundShare, format: "percent" },
      ]}
      note="Returns use completion date and refunds use settlement date. They stay separate and are never added together as one loss."
    />
  );
}

async function InventoryVelocityWidget({
  data,
}: {
  data: ReturnType<typeof getInventoryVelocity>;
}) {
  return <InventoryVelocity items={await data} />;
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

async function SearchMetricWidget({
  data,
  metric,
}: {
  data: Promise<SearchAnalytics>;
  metric: "clicks" | "impressions" | "ctr" | "position";
}) {
  return <SearchMetricCard data={await data} metric={metric} />;
}

async function SearchTrend({ data }: { data: Promise<SearchAnalytics> }) {
  return <SearchTrendWidget data={await data} />;
}

async function SearchRanking({
  data,
  kind,
  reportHref,
}: {
  data: Promise<SearchAnalytics>;
  kind: "query" | "page";
  reportHref?: string;
}) {
  return (
    <SearchRankingWidget
      data={await data}
      kind={kind}
      reportHref={reportHref}
    />
  );
}

async function StorefrontMetric({
  data,
  metric,
}: {
  data: Promise<StorefrontAnalytics>;
  metric: "visitors" | "sessions" | "pageViews";
}) {
  const result = await data;
  const labels = {
    visitors: "Storefront visitors",
    sessions: "Storefront sessions",
    pageViews: "Storefront page views",
  } as const;
  return <MetricCard label={labels[metric]} stat={result[metric]} />;
}

async function StorefrontFunnel({
  data,
}: {
  data: Promise<StorefrontAnalytics>;
}) {
  const result = await data;
  return (
    <AnalyticsSummaryCard
      title="Storefront conversion funnel"
      subtitle="Consented sessions with steps completed in order"
      items={[
        { label: "Sessions", value: result.sessions.value },
        { label: "Viewed a product", value: result.productSessions },
        { label: "Added to cart", value: result.cartSessions },
        { label: "Reached checkout", value: result.checkoutSessions },
        { label: "Converted sessions", value: result.convertedSessions },
        {
          label: "Conversion rate",
          value: result.conversionRate,
          format: "percent",
        },
      ]}
      note="Visitors who reject analytics and filtered automated traffic are not counted. Aggregates refresh hourly."
    />
  );
}

async function GrossProfitMetric({
  data,
}: {
  data: Promise<GrossMarginAnalytics>;
}) {
  const result = await data;
  return (
    <MetricCard
      label="Gross profit"
      stat={{
        value: result.grossProfit,
        trendPct: null,
        trendUp: result.grossProfit >= 0,
        spark: [],
      }}
      currency
    />
  );
}

async function GrossMarginWidget({
  data,
}: {
  data: Promise<GrossMarginAnalytics>;
}) {
  const result = await data;
  return (
    <AnalyticsSummaryCard
      title="Gross margin"
      subtitle="Recognized merchandise lines with a cost snapshot"
      items={[
        {
          label: "Costed sales",
          value: result.costedSales,
          format: "currency",
        },
        {
          label: "Cost of goods",
          value: result.costOfGoods,
          format: "currency",
        },
        {
          label: "Gross profit",
          value: result.grossProfit,
          format: "currency",
        },
        {
          label: "Gross margin",
          value: result.marginPercent,
          format: "percent",
        },
        {
          label: "Cost coverage",
          value: result.coveragePercent,
          format: "percent",
        },
      ]}
      note="Before returns and refunds. Missing costs are excluded, never counted as zero. Add costs in Products to improve coverage."
    />
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsSearchParams>;
}) {
  const access = await requireSectionAccess("analytics", "view");
  const showBlogApprovals = access.can("blogs", "view");
  const showEnquiries = access.can("enquiries", "view");
  const [storeId, locationScope, params, platformFeatures] = await Promise.all([
    getActingStoreId(),
    getViewerLocations(),
    searchParams,
    getPlatformAnalyticsFeatures(),
  ]);
  if (!platformFeatures.coreDashboard) {
    return (
      <div className="dash-analytics">
        <header className="dash-an-head">
          <h1>Analytics</h1>
        </header>
        <div className="dash-card p-8 text-center">
          <h2 className="text-base font-semibold">Analytics is unavailable</h2>
          <p className="mt-2 text-sm text-[var(--dash-text-3)]">
            StoreMink has temporarily disabled the Analytics dashboard. Your
            store data is unchanged.
          </p>
        </div>
      </div>
    );
  }
  // Resolve the store plan once for this render. Calling the per-feature DAL
  // for every card repeated the same stores read five times.
  const [{ plan }, timeZone, locationOptions] = await Promise.all([
    getStorePlanContext(storeId),
    getStoreAnalyticsTimeZone(storeId),
    getAnalyticsLocationOptions(storeId, locationScope),
  ]);
  const canUse = (feature: Parameters<typeof analyticsFeatureAllowed>[1]) =>
    analyticsFeatureAllowed(platformFeatures, feature, plan);
  const canCustomize = canUse("dashboardCustomization");
  const canUseReports = canUse("drilldownReports");
  const canUseSearch = canUse("googleSearchConsole");
  const range: AnalyticsRange = parseAnalyticsRange(params, timeZone);
  const location = resolveAnalyticsLocation(
    params.location,
    locationScope,
    locationOptions,
  );

  // Start every independent data source together. Each slot awaits only its own
  // promise under Suspense, so a slow activity query cannot hold sales cards.
  const sales = getSalesAnalytics(storeId, location, range);
  const catalog = getCatalogSnapshots(storeId);
  const categories = getTopCategories(storeId, location, range);
  const topProducts = getTopProducts(storeId, location, range);
  const channelSales = getSalesByChannel(storeId, location, range);
  const paymentSales = getSalesByPaymentMethod(storeId, location, range);
  const locationSales =
    locationOptions.length > 0
      ? getSalesByLocation(storeId, location, range)
      : Promise.resolve([]);
  const recentOrders = getRecentOrders(storeId, location, range);
  const activity = getActivity(storeId, location, range, {
    includeEnquiries: showEnquiries,
    includeBlogs: showBlogApprovals,
  });
  const customerMix = getCustomerMix(storeId, location, range);
  const discounts = getDiscountImpact(storeId, location, range);
  const returns = getReturnsAndRefunds(storeId, location, range);
  const velocity = getInventoryVelocity(storeId, location, range);
  const search = canUseSearch ? getSearchAnalytics(storeId, range) : null;
  const storefront = canUse("storefrontConversion")
    ? getStorefrontAnalytics(storeId, range)
    : null;
  const margin = canUse("grossMargin")
    ? getGrossMarginAnalytics(storeId, location, range)
    : null;
  const totalSalesReport = canUseReports
    ? analyticsReportHref("total-sales", params)
    : undefined;
  const salesOverTimeReport = canUseReports
    ? analyticsReportHref("sales-over-time", params)
    : undefined;
  const topProductsReport = canUseReports
    ? analyticsReportHref("top-products", params)
    : undefined;
  const searchQueriesReport =
    canUseReports && canUseSearch
      ? analyticsReportHref("search-queries", params)
      : undefined;

  const slots: Partial<Record<WidgetId, ReactNode>> = {
    metric_revenue: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric
          data={sales}
          metric="sales"
          reportHref={totalSalesReport}
        />
      </Suspense>
    ),
    metric_orders: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="orders" />
      </Suspense>
    ),
    metric_aov: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="aov" />
      </Suspense>
    ),
    metric_units: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SalesMetric data={sales} metric="units" />
      </Suspense>
    ),
    metric_products: (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SnapshotMetric data={catalog} metric="products" />
      </Suspense>
    ),
    revenue_chart: (
      <Suspense fallback={<WidgetSkeleton />}>
        <SalesChart data={sales} reportHref={salesOverTimeReport} />
      </Suspense>
    ),
    top_categories: (
      <Suspense fallback={<WidgetSkeleton />}>
        <CategoryWidget data={categories} />
      </Suspense>
    ),
    top_products: (
      <Suspense fallback={<WidgetSkeleton />}>
        <TopProductsWidget data={topProducts} reportHref={topProductsReport} />
      </Suspense>
    ),
    sales_by_channel: (
      <Suspense fallback={<WidgetSkeleton />}>
        <BreakdownWidget
          data={channelSales}
          title="Sales by channel"
          subtitle="Recognized sales less completed refunds"
        />
      </Suspense>
    ),
    sales_by_payment: (
      <Suspense fallback={<WidgetSkeleton />}>
        <BreakdownWidget
          data={paymentSales}
          title="Sales by payment method"
          subtitle="Tender values less completed refunds"
        />
      </Suspense>
    ),
    customer_mix: (
      <Suspense fallback={<WidgetSkeleton />}>
        <CustomerMixWidget data={customerMix} />
      </Suspense>
    ),
    discount_impact: (
      <Suspense fallback={<WidgetSkeleton />}>
        <DiscountWidget data={discounts} />
      </Suspense>
    ),
    returns_refunds: (
      <Suspense fallback={<WidgetSkeleton />}>
        <ReturnsWidget data={returns} sales={sales} />
      </Suspense>
    ),
    inventory_velocity: (
      <Suspense fallback={<WidgetSkeleton />}>
        <InventoryVelocityWidget data={velocity} />
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
  if (search) {
    slots.search_clicks = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="clicks" />
      </Suspense>
    );
    slots.search_impressions = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="impressions" />
      </Suspense>
    );
    slots.search_ctr = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="ctr" />
      </Suspense>
    );
    slots.search_position = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <SearchMetricWidget data={search} metric="position" />
      </Suspense>
    );
    slots.search_trend = (
      <Suspense fallback={<WidgetSkeleton />}>
        <SearchTrend data={search} />
      </Suspense>
    );
    slots.search_queries = (
      <Suspense fallback={<WidgetSkeleton />}>
        <SearchRanking
          data={search}
          kind="query"
          reportHref={searchQueriesReport}
        />
      </Suspense>
    );
    slots.search_pages = (
      <Suspense fallback={<WidgetSkeleton />}>
        <SearchRanking data={search} kind="page" />
      </Suspense>
    );
  }
  if (storefront) {
    slots.traffic_visitors = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <StorefrontMetric data={storefront} metric="visitors" />
      </Suspense>
    );
    slots.traffic_sessions = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <StorefrontMetric data={storefront} metric="sessions" />
      </Suspense>
    );
    slots.traffic_page_views = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <StorefrontMetric data={storefront} metric="pageViews" />
      </Suspense>
    );
    slots.traffic_funnel = (
      <Suspense fallback={<WidgetSkeleton />}>
        <StorefrontFunnel data={storefront} />
      </Suspense>
    );
  }
  if (margin) {
    slots.metric_gross_profit = (
      <Suspense fallback={<WidgetSkeleton compact />}>
        <GrossProfitMetric data={margin} />
      </Suspense>
    );
    slots.gross_margin_overview = (
      <Suspense fallback={<WidgetSkeleton />}>
        <GrossMarginWidget data={margin} />
      </Suspense>
    );
  }
  if (locationOptions.length > 0) {
    slots.sales_by_location = (
      <Suspense fallback={<WidgetSkeleton />}>
        <BreakdownWidget
          data={locationSales}
          title="Sales by location"
          subtitle="Physical shops and online / unassigned orders"
        />
      </Suspense>
    );
  }
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
        headerExtras={
          <>
            <AnalyticsFilters
              range={range}
              locations={locationOptions}
              selectedLocationId={location.selectedId}
            />
            <Link href="/dashboard/settings/analytics" className="dash-an-btn">
              Tracking settings
            </Link>
          </>
        }
        initialLayout={initialLayout}
        canCustomize={canCustomize}
      />
    </div>
  );
}
