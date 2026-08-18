import {
  WIDGETS,
  defaultLayoutFor,
  normalizeLayout,
  type WidgetId,
} from "@/app/dashboard/analytics/widgets";

export const ANALYTICS_LAYOUT_SCHEMA_VERSION = 1;
export const MAX_ANALYTICS_LAYOUT_BYTES = 8_192;

export interface StoredAnalyticsLayoutV1 {
  defaultRevision: 1;
  widgetIds: WidgetId[];
}

export interface AnalyticsLayoutView {
  items: WidgetId[];
  configured: boolean;
  updatedAt: string | null;
}

export function sanitizeWidgetIds(raw: unknown): WidgetId[] | null {
  if (!Array.isArray(raw) || raw.length > Object.keys(WIDGETS).length) {
    return null;
  }
  const out: WidgetId[] = [];
  const seen = new Set<WidgetId>();
  for (const value of raw) {
    if (typeof value !== "string" || !(value in WIDGETS)) return null;
    const id = value as WidgetId;
    if (seen.has(id)) return null;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function sanitizeStoredAnalyticsLayout(
  raw: unknown,
): StoredAnalyticsLayoutV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (JSON.stringify(raw).length > MAX_ANALYTICS_LAYOUT_BYTES) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.defaultRevision !== 1) return null;
  if (!Array.isArray(candidate.widgetIds) || candidate.widgetIds.length > 100) {
    return null;
  }
  const widgetIds: WidgetId[] = [];
  const seen = new Set<WidgetId>();
  for (const value of candidate.widgetIds) {
    if (typeof value !== "string" || value.length > 100) return null;
    // Retired ids are ignored on read. Client writes remain strict, so an
    // invented id can never be introduced through the action.
    if (!(value in WIDGETS)) continue;
    const id = value as WidgetId;
    if (seen.has(id)) continue;
    seen.add(id);
    widgetIds.push(id);
  }
  return widgetIds ? { defaultRevision: 1, widgetIds } : null;
}

export function storedAnalyticsLayout(widgetIds: WidgetId[]) {
  return {
    defaultRevision: 1,
    widgetIds,
  } satisfies StoredAnalyticsLayoutV1;
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
      items: defaultLayoutFor(allowed),
      configured,
      updatedAt,
    };
  }
  return {
    items:
      normalizeLayout(stored.widgetIds, allowed) ?? defaultLayoutFor(allowed),
    configured: true,
    updatedAt,
  };
}
