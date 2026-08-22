import { describe, expect, it } from "vitest";
import { WIDGETS, type WidgetId } from "@/app/dashboard/analytics/widgets";
import {
  analyticsWidgetGridRows,
  availableWidgetSizes,
  defaultAnalyticsSections,
  layoutForViewer,
  sanitizeAnalyticsLayoutInput,
  sanitizeStoredAnalyticsLayout,
} from "./layout";

describe("analytics layout v2 contract", () => {
  const allowed = ["metric_revenue", "metric_orders"] as const;

  it("builds named defaults with semantic sizes", () => {
    expect(defaultAnalyticsSections(allowed)).toEqual([
      {
        id: "overview",
        title: "Overview",
        hidden: false,
        items: [
          { widgetId: "metric_revenue", size: "compact" },
          { widgetId: "metric_orders", size: "compact" },
        ],
      },
    ]);
    expect(availableWidgetSizes("revenue_chart")).toEqual(["half", "full"]);
  });

  it("gives every editor card a stable vertical grid footprint", () => {
    const all = Object.keys(WIDGETS) as WidgetId[];
    expect(all.every((widgetId) => analyticsWidgetGridRows(widgetId) > 0)).toBe(
      true,
    );
    expect(analyticsWidgetGridRows("metric_revenue")).toBe(2);
    expect(analyticsWidgetGridRows("blog_approvals")).toBe(6);
    expect(analyticsWidgetGridRows("revenue_chart")).toBe(7);
  });

  it("uses the seller-performance cards for untouched dashboards", () => {
    const all = Object.keys(WIDGETS) as WidgetId[];
    expect(
      defaultAnalyticsSections(all).map((section) => ({
        title: section.title,
        cards: section.items.map((item) => item.widgetId),
      })),
    ).toEqual([
      {
        title: "Overview",
        cards: [
          "metric_revenue",
          "metric_orders",
          "metric_aov",
          "metric_units",
        ],
      },
      {
        title: "Sales",
        cards: [
          "revenue_chart",
          "top_products",
          "sales_by_channel",
          "sales_by_location",
        ],
      },
      {
        title: "Customers",
        cards: ["customer_mix", "metric_customers"],
      },
      {
        title: "Profit",
        cards: ["metric_gross_profit", "gross_margin_overview"],
      },
      {
        title: "Google Search",
        cards: [
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
        title: "Storefront traffic",
        cards: [
          "traffic_visitors",
          "traffic_sessions",
          "traffic_page_views",
          "traffic_funnel",
        ],
      },
    ]);
  });

  it("strictly validates section titles, ids, unique cards, and minimum sizes", () => {
    const valid = {
      defaultRevision: 2,
      sections: [
        {
          id: "sales",
          title: "Sales",
          hidden: false,
          items: [{ widgetId: "revenue_chart", size: "half" }],
        },
      ],
    };
    expect(sanitizeAnalyticsLayoutInput(valid)).toEqual(valid);
    expect(
      sanitizeAnalyticsLayoutInput({
        ...valid,
        sections: [{ ...valid.sections[0], title: " " }],
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsLayoutInput({
        ...valid,
        sections: [
          {
            ...valid.sections[0],
            items: [{ widgetId: "revenue_chart", size: "compact" }],
          },
        ],
      }),
    ).toBeNull();
  });

  it("migrates a v1 flat order without changing its order", () => {
    expect(
      sanitizeStoredAnalyticsLayout({
        defaultRevision: 1,
        widgetIds: ["metric_orders", "metric_revenue"],
      }),
    ).toEqual({
      defaultRevision: 2,
      sections: [
        {
          id: "overview",
          title: "Overview",
          hidden: false,
          items: [
            { widgetId: "metric_orders", size: "compact" },
            { widgetId: "metric_revenue", size: "compact" },
          ],
        },
      ],
    });
  });

  it("ignores retired stored cards but rejects them on client writes", () => {
    const stored = {
      defaultRevision: 2,
      sections: [
        {
          id: "overview",
          title: "Overview",
          hidden: false,
          items: [
            { widgetId: "retired_widget", size: "compact" },
            { widgetId: "metric_orders", size: "compact" },
          ],
        },
      ],
    };
    expect(sanitizeStoredAnalyticsLayout(stored)?.sections[0].items).toEqual([
      { widgetId: "metric_orders", size: "compact" },
    ]);
    expect(sanitizeAnalyticsLayoutInput(stored)).toBeNull();
  });

  it("filters dormant cards without deleting their section metadata", () => {
    const result = layoutForViewer(
      {
        defaultRevision: 2,
        sections: [
          {
            id: "custom",
            title: "My section",
            hidden: true,
            items: [
              { widgetId: "metric_customers", size: "compact" },
              { widgetId: "metric_orders", size: "half" },
            ],
          },
        ],
      },
      allowed,
      true,
      "t1",
    );
    expect(result).toEqual({
      sections: [
        {
          id: "custom",
          title: "My section",
          hidden: true,
          items: [{ widgetId: "metric_orders", size: "half" }],
        },
      ],
      configured: true,
      updatedAt: "t1",
    });
  });
});
