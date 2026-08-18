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
  | "metric_customers"
  | "metric_products"
  | "revenue_chart"
  | "top_categories"
  | "recent_orders"
  | "activity"
  | "blog_approvals"
  | "enquiries";

export type WidgetGroup = "Metrics" | "Sales" | "Customers" | "Content";

export interface WidgetMeta {
  id: WidgetId;
  title: string;
  description: string;
  group: WidgetGroup;
}

export const WIDGETS: Record<WidgetId, WidgetMeta> = {
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
};

export const WIDGET_GROUPS: WidgetGroup[] = [
  "Metrics",
  "Sales",
  "Customers",
  "Content",
];

/** The out-of-the-box dashboard, in render order. Lays out as four tidy rows. */
export const DEFAULT_LAYOUT: WidgetId[] = [
  "metric_revenue",
  "metric_orders",
  "metric_customers",
  "metric_products",
  "revenue_chart",
  "top_categories",
  "recent_orders",
  "activity",
  "blog_approvals",
  "enquiries",
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
