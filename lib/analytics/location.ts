import type { LocationScope } from "@/lib/locations/scope";

export interface AnalyticsLocationOption {
  id: string;
  name: string;
}

/** The resolved order scope used by every location-aware analytics query. */
export interface AnalyticsLocationSelection {
  /** null means all store locations; an array is an explicit location set. */
  locationIds: string[] | null;
  /** Online/unrouted orders belong in aggregate views, not a physical-location view. */
  includeUnassigned: boolean;
  /** The validated URL selection, or null for all accessible locations. */
  selectedId: string | null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Intersect the requested URL filter with server-derived location access.
 * Invalid, inaccessible, and repeated values safely fall back to the viewer's
 * complete accessible scope rather than becoming an authorization input.
 */
export function resolveAnalyticsLocation(
  requested: string | string[] | undefined,
  viewerScope: LocationScope,
  options: readonly AnalyticsLocationOption[],
): AnalyticsLocationSelection {
  const value = first(requested);
  const allowedOptions = new Set(options.map((option) => option.id));
  const selected = value && allowedOptions.has(value) ? value : null;
  if (selected) {
    return {
      locationIds: [selected],
      includeUnassigned: false,
      selectedId: selected,
    };
  }
  return {
    locationIds: viewerScope === null ? null : [...viewerScope],
    includeUnassigned: true,
    selectedId: null,
  };
}
