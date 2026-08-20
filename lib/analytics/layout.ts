import { WIDGETS, type WidgetId } from "@/app/dashboard/analytics/widgets";

export const ANALYTICS_LAYOUT_SCHEMA_VERSION = 2;
export const MAX_ANALYTICS_LAYOUT_BYTES = 8_192;
export const MAX_ANALYTICS_SECTIONS = 12;
export const MAX_ANALYTICS_SECTION_TITLE = 60;

export const ANALYTICS_WIDGET_SIZES = ["compact", "half", "full"] as const;
export type AnalyticsWidgetSize = (typeof ANALYTICS_WIDGET_SIZES)[number];

/**
 * The editor uses a fixed-height grid so a tall card cannot stretch the empty
 * landing cells beside it. Each widget owns a stable vertical footprint; the
 * saved compact/half/full preference controls only its width.
 */
export const ANALYTICS_WIDGET_GRID_ROWS: Record<WidgetId, number> = {
  traffic_visitors: 2,
  traffic_sessions: 2,
  traffic_page_views: 2,
  traffic_funnel: 6,
  metric_revenue: 2,
  metric_orders: 2,
  metric_aov: 2,
  metric_units: 2,
  metric_customers: 2,
  metric_products: 2,
  revenue_chart: 7,
  top_categories: 7,
  top_products: 7,
  sales_by_channel: 6,
  sales_by_location: 6,
  sales_by_payment: 6,
  customer_mix: 6,
  discount_impact: 6,
  returns_refunds: 7,
  inventory_velocity: 6,
  recent_orders: 7,
  activity: 7,
  blog_approvals: 6,
  enquiries: 5,
  search_clicks: 4,
  search_impressions: 4,
  search_ctr: 4,
  search_position: 4,
  search_trend: 7,
  search_queries: 7,
  search_pages: 7,
};

export function analyticsWidgetGridRows(widgetId: WidgetId): number {
  return ANALYTICS_WIDGET_GRID_ROWS[widgetId];
}

export interface AnalyticsLayoutItem {
  widgetId: WidgetId;
  size: AnalyticsWidgetSize;
}

export interface AnalyticsLayoutSection {
  id: string;
  title: string;
  hidden: boolean;
  items: AnalyticsLayoutItem[];
}

export interface StoredAnalyticsLayoutV2 {
  defaultRevision: 2;
  sections: AnalyticsLayoutSection[];
}

interface StoredAnalyticsLayoutV1 {
  defaultRevision: 1;
  widgetIds: WidgetId[];
}

export interface AnalyticsLayoutView {
  sections: AnalyticsLayoutSection[];
  configured: boolean;
  updatedAt: string | null;
}

const SIZE_RANK: Record<AnalyticsWidgetSize, number> = {
  compact: 0,
  half: 1,
  full: 2,
};

export const WIDGET_SIZE_RULES: Record<
  WidgetId,
  { default: AnalyticsWidgetSize; min: AnalyticsWidgetSize }
> = {
  traffic_visitors: { default: "compact", min: "compact" },
  traffic_sessions: { default: "compact", min: "compact" },
  traffic_page_views: { default: "compact", min: "compact" },
  traffic_funnel: { default: "full", min: "half" },
  metric_revenue: { default: "compact", min: "compact" },
  metric_orders: { default: "compact", min: "compact" },
  metric_aov: { default: "compact", min: "compact" },
  metric_units: { default: "compact", min: "compact" },
  metric_customers: { default: "compact", min: "compact" },
  metric_products: { default: "compact", min: "compact" },
  revenue_chart: { default: "full", min: "half" },
  top_categories: { default: "half", min: "half" },
  top_products: { default: "half", min: "half" },
  sales_by_channel: { default: "half", min: "half" },
  sales_by_location: { default: "full", min: "half" },
  sales_by_payment: { default: "half", min: "half" },
  customer_mix: { default: "half", min: "half" },
  discount_impact: { default: "half", min: "half" },
  returns_refunds: { default: "half", min: "half" },
  inventory_velocity: { default: "half", min: "half" },
  recent_orders: { default: "half", min: "half" },
  activity: { default: "half", min: "half" },
  blog_approvals: { default: "compact", min: "compact" },
  enquiries: { default: "full", min: "half" },
  search_clicks: { default: "compact", min: "compact" },
  search_impressions: { default: "compact", min: "compact" },
  search_ctr: { default: "compact", min: "compact" },
  search_position: { default: "compact", min: "compact" },
  search_trend: { default: "full", min: "half" },
  search_queries: { default: "half", min: "half" },
  search_pages: { default: "half", min: "half" },
};

const DEFAULT_SECTIONS: Array<{
  id: string;
  title: string;
  widgets: WidgetId[];
}> = [
  {
    id: "overview",
    title: "Overview",
    widgets: ["metric_revenue", "metric_orders", "metric_aov", "metric_units"],
  },
  {
    id: "sales",
    title: "Sales",
    widgets: [
      "revenue_chart",
      "top_products",
      "sales_by_channel",
      "sales_by_location",
    ],
  },
  {
    id: "customers",
    title: "Customers",
    widgets: ["customer_mix", "metric_customers"],
  },
  {
    id: "google-search",
    title: "Google Search",
    widgets: [
      "search_clicks",
      "search_impressions",
      "search_ctr",
      "search_position",
      "search_trend",
      "search_queries",
      "search_pages",
    ],
  },
  {
    id: "storefront-traffic",
    title: "Storefront traffic",
    widgets: [
      "traffic_visitors",
      "traffic_sessions",
      "traffic_page_views",
      "traffic_funnel",
    ],
  },
];

const SECTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SIZE_SET = new Set<string>(ANALYTICS_WIDGET_SIZES);

function cloneSections(
  sections: readonly AnalyticsLayoutSection[],
): AnalyticsLayoutSection[] {
  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => ({ ...item })),
  }));
}

export function defaultWidgetSize(widgetId: WidgetId): AnalyticsWidgetSize {
  return WIDGET_SIZE_RULES[widgetId].default;
}

export function widgetAllowsSize(
  widgetId: WidgetId,
  size: AnalyticsWidgetSize,
): boolean {
  return SIZE_RANK[size] >= SIZE_RANK[WIDGET_SIZE_RULES[widgetId].min];
}

export function availableWidgetSizes(
  widgetId: WidgetId,
): AnalyticsWidgetSize[] {
  return ANALYTICS_WIDGET_SIZES.filter((size) =>
    widgetAllowsSize(widgetId, size),
  );
}

export function defaultAnalyticsSections(
  allowed: readonly WidgetId[],
): AnalyticsLayoutSection[] {
  const permitted = new Set(allowed);
  return DEFAULT_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    hidden: false,
    items: section.widgets
      .filter((widgetId) => permitted.has(widgetId))
      .map((widgetId) => ({
        widgetId,
        size: defaultWidgetSize(widgetId),
      })),
  })).filter((section) => section.items.length > 0);
}

/** Convert the old flat browser/server order without losing its ordering. */
export function legacyLayoutFromWidgetIds(
  widgetIds: readonly WidgetId[],
): StoredAnalyticsLayoutV2 {
  return {
    defaultRevision: 2,
    sections: [
      {
        id: "overview",
        title: "Overview",
        hidden: false,
        items: widgetIds.map((widgetId) => ({
          widgetId,
          size: defaultWidgetSize(widgetId),
        })),
      },
    ],
  };
}

function safeJsonSize(raw: unknown): number | null {
  try {
    return JSON.stringify(raw).length;
  } catch {
    return null;
  }
}

function sanitizeV1(
  raw: Record<string, unknown>,
): StoredAnalyticsLayoutV1 | null {
  if (raw.defaultRevision !== 1 || !Array.isArray(raw.widgetIds)) return null;
  if (raw.widgetIds.length > 100) return null;
  const widgetIds: WidgetId[] = [];
  const seen = new Set<WidgetId>();
  for (const value of raw.widgetIds) {
    if (typeof value !== "string" || value.length > 100) return null;
    if (!(value in WIDGETS)) continue;
    const id = value as WidgetId;
    if (seen.has(id)) continue;
    seen.add(id);
    widgetIds.push(id);
  }
  return { defaultRevision: 1, widgetIds };
}

function sanitizeV2(
  raw: Record<string, unknown>,
  strict: boolean,
): StoredAnalyticsLayoutV2 | null {
  if (raw.defaultRevision !== 2 || !Array.isArray(raw.sections)) return null;
  if (raw.sections.length > MAX_ANALYTICS_SECTIONS) return null;

  const sections: AnalyticsLayoutSection[] = [];
  const sectionIds = new Set<string>();
  const widgetIds = new Set<WidgetId>();

  for (const value of raw.sections) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const section = value as Record<string, unknown>;
    const id = typeof section.id === "string" ? section.id.trim() : "";
    const title = typeof section.title === "string" ? section.title.trim() : "";
    if (
      !SECTION_ID_RE.test(id) ||
      sectionIds.has(id) ||
      !title ||
      title.length > MAX_ANALYTICS_SECTION_TITLE ||
      typeof section.hidden !== "boolean" ||
      !Array.isArray(section.items)
    ) {
      return null;
    }
    sectionIds.add(id);
    const items: AnalyticsLayoutItem[] = [];
    for (const entry of section.items) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const item = entry as Record<string, unknown>;
      if (
        typeof item.widgetId !== "string" ||
        typeof item.size !== "string" ||
        !SIZE_SET.has(item.size)
      ) {
        return null;
      }
      if (!(item.widgetId in WIDGETS)) {
        if (strict) return null;
        continue;
      }
      const widgetId = item.widgetId as WidgetId;
      const size = item.size as AnalyticsWidgetSize;
      if (widgetIds.has(widgetId)) {
        if (strict) return null;
        continue;
      }
      if (!widgetAllowsSize(widgetId, size)) {
        if (strict) return null;
        continue;
      }
      widgetIds.add(widgetId);
      items.push({ widgetId, size });
    }
    sections.push({ id, title, hidden: section.hidden, items });
  }
  return { defaultRevision: 2, sections };
}

/** Strict client-write validation. Unknown/duplicate/undersized cards fail. */
export function sanitizeAnalyticsLayoutInput(
  raw: unknown,
): StoredAnalyticsLayoutV2 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bytes = safeJsonSize(raw);
  if (bytes === null || bytes > MAX_ANALYTICS_LAYOUT_BYTES) return null;
  return sanitizeV2(raw as Record<string, unknown>, true);
}

/** Lenient persisted read: v1 migrates; retired ids are ignored safely. */
export function sanitizeStoredAnalyticsLayout(
  raw: unknown,
): StoredAnalyticsLayoutV2 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bytes = safeJsonSize(raw);
  if (bytes === null || bytes > MAX_ANALYTICS_LAYOUT_BYTES) return null;
  const record = raw as Record<string, unknown>;
  const v2 = sanitizeV2(record, false);
  if (v2) return v2;
  const v1 = sanitizeV1(record);
  return v1 ? legacyLayoutFromWidgetIds(v1.widgetIds) : null;
}

export function storedAnalyticsLayout(
  sections: readonly AnalyticsLayoutSection[],
): StoredAnalyticsLayoutV2 {
  return { defaultRevision: 2, sections: cloneSections(sections) };
}

export function layoutForViewer(
  raw: unknown,
  allowed: readonly WidgetId[],
  configured: boolean,
  updatedAt: string | null,
): AnalyticsLayoutView {
  const stored = sanitizeStoredAnalyticsLayout(raw);
  if (!configured || !stored) {
    return {
      sections: defaultAnalyticsSections(allowed),
      configured,
      updatedAt,
    };
  }
  const permitted = new Set(allowed);
  return {
    sections: stored.sections.map((section) => ({
      ...section,
      items: section.items.filter((item) => permitted.has(item.widgetId)),
    })),
    configured: true,
    updatedAt,
  };
}
