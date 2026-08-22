import type { AnalyticsRange } from "@/lib/analytics/range";
import type { AnalyticsLocationOption } from "@/lib/analytics/location";

const RANGES = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["90d", "Last 90 days"],
  ["mtd", "Month to date"],
  ["ytd", "Year to date"],
  ["12m", "Last 12 months"],
  ["custom", "Custom"],
] as const;

const COMPARISONS = [
  ["previous", "Previous period"],
  ["year", "Previous year"],
  ["custom", "Custom comparison"],
  ["none", "No comparison"],
] as const;

export function AnalyticsFilters({
  range,
  locations,
  selectedLocationId,
}: {
  range: AnalyticsRange;
  locations: AnalyticsLocationOption[];
  selectedLocationId: string | null;
}) {
  return (
    <form method="get" className="dash-an-filters">
      <select name="range" defaultValue={range.preset} aria-label="Date range">
        {RANGES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select
        name="compare"
        defaultValue={range.comparison}
        aria-label="Comparison"
      >
        {COMPARISONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {locations.length > 0 ? (
        <select
          name="location"
          defaultValue={selectedLocationId ?? "all"}
          aria-label="Location"
        >
          <option value="all">All accessible locations</option>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      ) : null}
      <details className="dash-an-custom-dates">
        <summary>Custom dates</summary>
        <div>
          <label>
            Range start
            <input type="date" name="from" defaultValue={range.customFrom} />
          </label>
          <label>
            Range end
            <input type="date" name="to" defaultValue={range.customTo} />
          </label>
          <label>
            Comparison start
            <input
              type="date"
              name="compareFrom"
              defaultValue={range.compareFrom}
            />
          </label>
          <label>
            Comparison end
            <input
              type="date"
              name="compareTo"
              defaultValue={range.compareTo}
            />
          </label>
        </div>
      </details>
      <button type="submit">Apply</button>
      <span
        className="dash-an-zone"
        title={`Calendar boundaries use ${range.timeZone}`}
      >
        {range.timeZone}
      </span>
    </form>
  );
}
