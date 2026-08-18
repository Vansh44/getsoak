import { Suspense, type ReactNode } from "react";
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
import { isWidgetId, type WidgetId } from "./widgets";
import {
  parseAnalyticsRange,
  type AnalyticsRange,
  type AnalyticsSearchParams,
} from "@/lib/analytics/range";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { getAnalyticsDashboardLayout } from "@/lib/analytics/layout-store";
import { resolveAnalyticsLocation } from "@/lib/analytics/location";
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
  metric: "sales" | "orders" | "aov" | "units";
}) {
  const result = await data;
  if (metric === "sales")
    return <MetricCard label="Total sales" stat={result.totalSales} currency />;
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

async function TopProductsWidget({
  data,
}: {
  data: ReturnType<typeof getTopProducts>;
}) {
  return <TopProducts items={await data} />;
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
  const locationOptions = await getAnalyticsLocationOptions(
    storeId,
    locationScope,
  );
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
  const activity = getActivity(storeId, location, range);
  const customerMix = getCustomerMix(storeId, location, range);
  const discounts = getDiscountImpact(storeId, location, range);
  const returns = getReturnsAndRefunds(storeId, location, range);
  const velocity = getInventoryVelocity(storeId, location, range);

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
        <SalesChart data={sales} />
      </Suspense>
    ),
    top_categories: (
      <Suspense fallback={<WidgetSkeleton />}>
        <CategoryWidget data={categories} />
      </Suspense>
    ),
    top_products: (
      <Suspense fallback={<WidgetSkeleton />}>
        <TopProductsWidget data={topProducts} />
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
          <AnalyticsFilters
            range={range}
            locations={locationOptions}
            selectedLocationId={location.selectedId}
          />
        }
        initialLayout={initialLayout}
      />
    </div>
  );
}
