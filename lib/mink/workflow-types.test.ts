import { describe, expect, it } from "vitest";
import { buildWeeklyTradingReportResult } from "./workflow-types";

describe("weekly trading report result", () => {
  it("builds deterministic highlights without model output", () => {
    const result = buildWeeklyTradingReportResult({
      rangeLabel: "Last 7 days",
      comparisonLabel: "Previous 7 days",
      fromInclusive: "2026-08-25T00:00:00.000Z",
      toExclusive: "2026-09-01T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      locationLabel: "Shop",
      netSales: 12500,
      netSalesTrendPercent: 12.5,
      orders: 20,
      ordersTrendPercent: 10,
      averageOrderValue: 625,
      averageOrderValueTrendPercent: 2,
      unitsSold: 31,
      unitsSoldTrendPercent: 8,
      topProducts: [
        {
          id: "product-1",
          name: "Basmati Rice",
          units: 12,
          amount: 4800,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
      channels: [
        { key: "online", name: "Online", amount: 7500, orders: 12, share: 60 },
        { key: "pos", name: "POS", amount: 5000, orders: 8, share: 40 },
      ],
      dataAsOf: "2026-09-01T00:01:00.000Z",
    });

    expect(result.analyticsPath).toBe(
      "/dashboard/analytics?range=7d&compare=previous",
    );
    expect(result.highlights).toEqual([
      "Net sales grew 12.5% versus the previous period.",
      "Basmati Rice led unit sales with 12 sold.",
      "Online was the largest sales channel at 60% of recognized net sales.",
    ]);
  });

  it("states the zero-order and missing-comparison cases accurately", () => {
    const result = buildWeeklyTradingReportResult({
      rangeLabel: "Last 7 days",
      comparisonLabel: null,
      fromInclusive: "2026-08-25T00:00:00.000Z",
      toExclusive: "2026-09-01T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      locationLabel: "All store locations",
      netSales: 0,
      netSalesTrendPercent: null,
      orders: 0,
      ordersTrendPercent: null,
      averageOrderValue: 0,
      averageOrderValueTrendPercent: null,
      unitsSold: 0,
      unitsSoldTrendPercent: null,
      topProducts: [],
      channels: [],
      dataAsOf: "2026-09-01T00:01:00.000Z",
    });
    expect(result.highlights).toEqual([
      "No recognized orders were recorded in this period.",
    ]);
  });
});
