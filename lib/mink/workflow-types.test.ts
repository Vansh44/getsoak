import { describe, expect, it } from "vitest";
import {
  buildProductLaunchPreparationResult,
  buildRevenueDeclineInvestigationResult,
  buildWeeklyTradingReportResult,
  narrowMinkWorkflowLocationIds,
} from "./workflow-types";

describe("durable workflow location authority", () => {
  const unrestrictedAtQueue = {
    locationIds: ["shop", "delhi"],
    restrictedLocationScope: false,
  };

  it("never adds locations that were not captured at queue time", () => {
    expect(
      narrowMinkWorkflowLocationIds(
        unrestrictedAtQueue,
        ["shop", "delhi", "mumbai"],
        null,
      ),
    ).toEqual(["shop", "delhi"]);
  });

  it("honours a new narrower binding created after queueing", () => {
    expect(
      narrowMinkWorkflowLocationIds(
        unrestrictedAtQueue,
        ["shop", "delhi"],
        ["delhi"],
      ),
    ).toEqual(["delhi"]);
  });

  it("fails closed when every binding is removed from a restricted actor", () => {
    expect(
      narrowMinkWorkflowLocationIds(
        {
          locationIds: ["shop"],
          restrictedLocationScope: true,
        },
        ["shop"],
        [],
      ),
    ).toBeNull();
  });
});

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

describe("revenue decline investigation result", () => {
  it("separates measured movements from causal caveats", () => {
    const result = buildRevenueDeclineInvestigationResult({
      period: "30d",
      rangeLabel: "Last 30 days",
      comparisonLabel: "Previous 30 days",
      fromInclusive: "2026-08-02T00:00:00.000Z",
      toExclusive: "2026-09-01T00:00:00.000Z",
      comparisonFromInclusive: "2026-07-03T00:00:00.000Z",
      comparisonToExclusive: "2026-08-02T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      locationLabel: "All store locations",
      current: {
        netSales: 8000,
        orders: 16,
        averageOrderValue: 500,
        unitsSold: 25,
      },
      previous: {
        netSales: 10000,
        orders: 20,
        averageOrderValue: 500,
        unitsSold: 30,
      },
      currentChannels: [
        { key: "online", name: "Online", amount: 5000, orders: 10, share: 63 },
      ],
      previousChannels: [
        { key: "online", name: "Online", amount: 7000, orders: 14, share: 70 },
      ],
      currentLocations: [],
      previousLocations: [],
      currentProducts: [
        {
          id: "product-1",
          name: "Basmati Rice",
          units: 8,
          amount: 2000,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
      previousProducts: [
        {
          id: "product-1",
          name: "Basmati Rice",
          units: 12,
          amount: 3000,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
      dataAsOf: "2026-09-01T00:01:00.000Z",
    });

    expect(result.metrics[0]).toMatchObject({
      delta: -2000,
      deltaPercent: -20,
    });
    expect(result.channelMovements[0]).toMatchObject({
      name: "Online",
      delta: -2000,
    });
    expect(result.findings.join(" ")).toContain("Order volume decreased");
    expect(result.caveats.join(" ")).toContain("not proof of causation");
    expect(result.analyticsPath).toBe(
      "/dashboard/analytics?range=30d&compare=previous",
    );
  });
});

describe("product launch preparation result", () => {
  it("blocks an out-of-stock launch without mutating or inventing content", () => {
    const result = buildProductLaunchPreparationResult({
      storeName: "Echos",
      productId: "product-1",
      productName: "Basmati Rice (Sample)",
      requestedSku: "SKU10010007V028",
      requestedVariantName: "5 kg",
      status: "draft",
      categoryName: "Groceries",
      featured: false,
      descriptionLength: 20,
      seoTitleLength: 0,
      seoDescriptionLength: 0,
      imageCount: 1,
      variantsTruncated: false,
      locationLabel: "Shop and Delhi",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      skus: [
        {
          productId: "product-1",
          variantId: "variant-1",
          productName: "Basmati Rice (Sample)",
          variantName: "5 kg",
          sku: "SKU10010007V028",
          basePrice: 500,
          sellingPrice: 450,
          specialPrice: null,
          trackInventory: true,
          lowStockThreshold: 5,
          totalStock: 0,
          locationStocks: [
            { locationId: "shop-1", locationName: "Shop", stock: 0 },
          ],
          requiresShipping: true,
          shippingMeasurementsComplete: false,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
      locationStock: [],
      dataAsOf: "2026-09-01T00:01:00.000Z",
      productDashboardPath: "/dashboard/products/product-1",
      inventoryDashboardPath: "/dashboard/inventory",
    });

    expect(result.readinessLabel).toBe("blocked");
    expect(result.blockers.join(" ")).toContain("out of stock");
    expect(result.warnings.join(" ")).toContain("human-approved action");
    expect(result.suggestedCopy).toEqual({
      headline: "Meet Basmati Rice (Sample) — 5 kg",
      subheading:
        "Discover Basmati Rice (Sample) — 5 kg in Groceries from Echos.",
      callToAction: "Discover more",
    });
    expect(result.checklist.join(" ")).toContain(
      "does not infer or contact recipients",
    );
  });

  it("warns when aggregate stock hides a location-level gap", () => {
    const result = buildProductLaunchPreparationResult({
      storeName: "Echos",
      productId: "product-1",
      productName: "Basmati Rice (Sample)",
      requestedSku: "SKU10010007V028",
      requestedVariantName: "5 kg",
      status: "published",
      categoryName: "Groceries",
      featured: false,
      descriptionLength: 120,
      seoTitleLength: 40,
      seoDescriptionLength: 120,
      imageCount: 2,
      variantsTruncated: false,
      locationLabel: "Shop and Delhi",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      skus: [
        {
          productId: "product-1",
          variantId: "variant-1",
          productName: "Basmati Rice (Sample)",
          variantName: "5 kg",
          sku: "SKU10010007V028",
          basePrice: 500,
          sellingPrice: 450,
          specialPrice: null,
          trackInventory: true,
          lowStockThreshold: 5,
          totalStock: 20,
          locationStocks: [
            { locationId: "shop-1", locationName: "Shop", stock: 20 },
            { locationId: "delhi-1", locationName: "Delhi", stock: 0 },
          ],
          requiresShipping: true,
          shippingMeasurementsComplete: true,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
      locationStock: [],
      dataAsOf: "2026-09-01T00:01:00.000Z",
      productDashboardPath: "/dashboard/products/product-1",
      inventoryDashboardPath: "/dashboard/inventory",
    });

    expect(result.readinessLabel).toBe("needs_attention");
    expect(result.warnings.join(" ")).toContain("SKU10010007V028 at Delhi");
  });
});
