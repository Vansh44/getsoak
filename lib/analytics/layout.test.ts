import { describe, expect, it } from "vitest";
import {
  layoutForViewer,
  sanitizeStoredAnalyticsLayout,
  sanitizeWidgetIds,
  storedAnalyticsLayout,
} from "./layout";

describe("analytics layout contract", () => {
  const allowed = ["metric_revenue", "metric_orders"] as const;

  it("accepts a bounded unique widget order, including an empty dashboard", () => {
    expect(sanitizeWidgetIds([...allowed])).toEqual(allowed);
    expect(sanitizeWidgetIds([])).toEqual([]);
  });

  it("rejects unknown and duplicate widget ids", () => {
    expect(sanitizeWidgetIds(["metric_orders", "metric_orders"])).toBeNull();
    expect(sanitizeWidgetIds(["made_up"])).toBeNull();
  });

  it("falls back safely for a corrupt saved row", () => {
    expect(
      layoutForViewer(
        { defaultRevision: 1, widgetIds: "nope" },
        allowed,
        true,
        "t1",
      ),
    ).toEqual({
      items: [...allowed],
      configured: true,
      updatedAt: "t1",
    });
  });

  it("ignores retired ids while retaining the known saved order", () => {
    expect(
      layoutForViewer(
        {
          defaultRevision: 1,
          widgetIds: ["retired_widget", "metric_orders", "metric_revenue"],
        },
        allowed,
        true,
        "t1",
      ).items,
    ).toEqual(["metric_orders", "metric_revenue"]);
  });

  it("filters dormant cards without deleting them from stored JSON", () => {
    const stored = storedAnalyticsLayout([
      "metric_revenue",
      "metric_customers",
      "metric_orders",
    ]);
    expect(sanitizeStoredAnalyticsLayout(stored)?.widgetIds).toContain(
      "metric_customers",
    );
    expect(layoutForViewer(stored, allowed, true, "t1").items).toEqual([
      "metric_revenue",
      "metric_orders",
    ]);
  });
});
