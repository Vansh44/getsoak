// The Analytics dashboard is COMPOSABLE: every card on the page is a "widget"
// the merchant can remove, re-order, or add back from the section library
// (Shopify's "Edit dashboard"). This file is the single registry — it is pure
// data (no JSX) so both the server page and the client canvas can import it.
//
// Adding a widget = add an entry here + render its node into the `slots` map in
// page.tsx. Everything else (library grouping and persistence) follows. Card
// size defaults and minimums live in lib/analytics/layout.ts because sizes are
// versioned user preferences rather than fixed widget metadata.

export type WidgetId =
  | "metric_revenue"
  | "metric_orders"
  | "metric_aov"
  | "metric_units"
  | "metric_customers"
  | "metric_products"
  | "revenue_chart"
  | "top_categories"
  | "top_products"
  | "sales_by_channel"
  | "sales_by_location"
  | "sales_by_payment"
  | "customer_mix"
  | "discount_impact"
  | "returns_refunds"
  | "inventory_velocity"
  | "recent_orders"
  | "activity"
  | "blog_approvals"
  | "enquiries"
  | "search_clicks"
  | "search_impressions"
  | "search_ctr"
  | "search_position"
  | "search_trend"
  | "search_queries"
  | "search_pages"
  | "traffic_visitors"
  | "traffic_sessions"
  | "traffic_page_views"
  | "traffic_funnel"
  | "metric_gross_profit"
  | "gross_margin_overview";

export type WidgetGroup =
  | "Metrics"
  | "Sales"
  | "Customers"
  | "Inventory"
  | "Content"
  | "Search"
  | "Traffic"
  | "Profit";

export interface WidgetMeta {
  id: WidgetId;
  title: string;
  description: string;
  group: WidgetGroup;
}

export const WIDGETS: Record<WidgetId, WidgetMeta> = {
  metric_gross_profit: {
    id: "metric_gross_profit",
    title: "Gross profit",
    description: "Sales less snapshotted product costs on costed order lines.",
    group: "Profit",
  },
  gross_margin_overview: {
    id: "gross_margin_overview",
    title: "Gross margin",
    description:
      "Costed merchandise sales, COGS, profit, margin, and coverage.",
    group: "Profit",
  },
  traffic_visitors: {
    id: "traffic_visitors",
    title: "Storefront visitors",
    description: "Consented daily visitors to your storefront.",
    group: "Traffic",
  },
  traffic_sessions: {
    id: "traffic_sessions",
    title: "Storefront sessions",
    description: "Consented visits separated by 30 minutes of inactivity.",
    group: "Traffic",
  },
  traffic_page_views: {
    id: "traffic_page_views",
    title: "Storefront page views",
    description: "Pages viewed during consented storefront sessions.",
    group: "Traffic",
  },
  traffic_funnel: {
    id: "traffic_funnel",
    title: "Storefront conversion funnel",
    description: "Ordered product, cart, checkout, and purchase steps.",
    group: "Traffic",
  },
  metric_revenue: {
    id: "metric_revenue",
    title: "Total sales",
    description:
      "Recognized sales less completed refunds in the selected range.",
    group: "Metrics",
  },
  metric_orders: {
    id: "metric_orders",
    title: "Orders",
    description: "Recognized orders placed in the selected range.",
    group: "Metrics",
  },
  metric_aov: {
    id: "metric_aov",
    title: "Average order value",
    description: "Total sales divided by recognized orders in the range.",
    group: "Metrics",
  },
  metric_units: {
    id: "metric_units",
    title: "Units sold",
    description: "Line-item quantity across recognized orders in the range.",
    group: "Metrics",
  },
  metric_customers: {
    id: "metric_customers",
    title: "Total customers",
    description: "Everyone who has an account on your store.",
    group: "Metrics",
  },
  metric_products: {
    id: "metric_products",
    title: "Products listed",
    description: "Published products in your catalog.",
    group: "Metrics",
  },
  revenue_chart: {
    id: "revenue_chart",
    title: "Total sales over time",
    description: "Recognized sales over the dashboard's selected date range.",
    group: "Sales",
  },
  top_categories: {
    id: "top_categories",
    title: "Sales by category",
    description: "Which categories bring in the most revenue.",
    group: "Sales",
  },
  top_products: {
    id: "top_products",
    title: "Top products",
    description: "Products ranked by units sold with merchandise value.",
    group: "Sales",
  },
  sales_by_channel: {
    id: "sales_by_channel",
    title: "Sales by channel",
    description: "Recognized sales from the online store and point of sale.",
    group: "Sales",
  },
  sales_by_location: {
    id: "sales_by_location",
    title: "Sales by location",
    description: "Recognized sales across physical and online locations.",
    group: "Sales",
  },
  sales_by_payment: {
    id: "sales_by_payment",
    title: "Sales by payment method",
    description: "Tender values less completed refunds to each method.",
    group: "Sales",
  },
  customer_mix: {
    id: "customer_mix",
    title: "New vs returning customers",
    description:
      "Customers grouped by their first accessible recognized order.",
    group: "Customers",
  },
  discount_impact: {
    id: "discount_impact",
    title: "Discount impact",
    description: "Order and line-item discounts in the selected range.",
    group: "Sales",
  },
  returns_refunds: {
    id: "returns_refunds",
    title: "Returns and refunds",
    description: "Completed returns and settled refunds in the selected range.",
    group: "Sales",
  },
  inventory_velocity: {
    id: "inventory_velocity",
    title: "Inventory velocity",
    description: "Tracked stock units consumed by recognized sales.",
    group: "Inventory",
  },
  recent_orders: {
    id: "recent_orders",
    title: "Recent orders",
    description: "The five most recent orders and their status.",
    group: "Sales",
  },
  activity: {
    id: "activity",
    title: "Recent activity",
    description: "Orders, enquiries and blog posts as they happen.",
    group: "Customers",
  },
  enquiries: {
    id: "enquiries",
    title: "Enquiries",
    description: "Enquiry counts by status plus the latest messages.",
    group: "Customers",
  },
  blog_approvals: {
    id: "blog_approvals",
    title: "Blog approvals",
    description: "Customer blog submissions awaiting your review.",
    group: "Content",
  },
  search_clicks: {
    id: "search_clicks",
    title: "Google Search clicks",
    description: "Visits started by a click from Google Search.",
    group: "Search",
  },
  search_impressions: {
    id: "search_impressions",
    title: "Google Search impressions",
    description: "Times Google showed a link to your store.",
    group: "Search",
  },
  search_ctr: {
    id: "search_ctr",
    title: "Search click-through rate",
    description: "Google Search clicks divided by impressions.",
    group: "Search",
  },
  search_position: {
    id: "search_position",
    title: "Average search position",
    description: "Impression-weighted average position in Google Search.",
    group: "Search",
  },
  search_trend: {
    id: "search_trend",
    title: "Google Search performance",
    description: "Clicks and impressions over time from Google Search.",
    group: "Search",
  },
  search_queries: {
    id: "search_queries",
    title: "Top Google searches",
    description: "Search terms ranked by clicks from Google.",
    group: "Search",
  },
  search_pages: {
    id: "search_pages",
    title: "Top search landing pages",
    description: "Store pages ranked by clicks from Google Search.",
    group: "Search",
  },
};

export const WIDGET_GROUPS: WidgetGroup[] = [
  "Metrics",
  "Sales",
  "Customers",
  "Inventory",
  "Content",
  "Search",
  "Traffic",
  "Profit",
];

/** The out-of-the-box dashboard, in render order. Lays out as four tidy rows. */
export const DEFAULT_LAYOUT: WidgetId[] = [
  "metric_revenue",
  "metric_orders",
  "metric_aov",
  "metric_units",
  "revenue_chart",
  "top_products",
  "sales_by_channel",
  "sales_by_location",
];

export function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === "string" && value in WIDGETS;
}

/**
 * Reconcile a persisted layout with what this viewer can actually see.
 * Unknown ids (renamed/retired widgets), duplicates, and widgets whose data the
 * viewer has no permission for are dropped — so a stale saved layout can never
 * break the page or leak a card the role shouldn't get. Returns null when the
 * input isn't a layout at all (no saved value / corrupt JSON), which the caller
 * distinguishes from a deliberately-emptied dashboard.
 */
export function normalizeLayout(
  saved: unknown,
  allowed: readonly WidgetId[],
): WidgetId[] | null {
  if (!Array.isArray(saved)) return null;
  const allow = new Set(allowed);
  const seen = new Set<WidgetId>();
  const out: WidgetId[] = [];
  for (const item of saved) {
    if (!isWidgetId(item) || seen.has(item) || !allow.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** The default layout, filtered to the widgets this viewer is allowed to see. */
export function defaultLayoutFor(allowed: readonly WidgetId[]): WidgetId[] {
  const allow = new Set(allowed);
  return DEFAULT_LAYOUT.filter((id) => allow.has(id));
}

/** localStorage key — per store, so switching stores doesn't inherit a layout. */
export function layoutStorageKey(storeId: string): string {
  return `sm.analytics.layout.v1.${storeId}`;
}
