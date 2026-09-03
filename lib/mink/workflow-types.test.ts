import { describe, expect, it } from "vitest";
import {
  buildDelayedPickupReviewResult,
  buildProductLaunchPreparationResult,
  buildRevenueDeclineInvestigationResult,
  buildSlowInventoryPromotionResult,
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

describe("slow inventory promotion result", () => {
  it("builds a bounded margin-aware recommendation without claiming an offer", () => {
    const result = buildSlowInventoryPromotionResult({
      storeName: "Echos",
      period: "30d",
      periodDays: 30,
      rangeLabel: "Last 30 days",
      fromInclusive: "2026-08-03T00:00:00.000Z",
      toExclusive: "2026-09-02T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      locationLabel: "Shop and Delhi",
      locationCount: 2,
      candidateShelves: [
        {
          productId: "product-1",
          variantId: "variant-1",
          productName: "Basmati Rice (Sample)",
          variantName: "5 kg",
          sku: "SKU10010007V028",
          locationId: "delhi-1",
          locationName: "Delhi",
          stock: 20,
          unitsSold: 2,
          salesAmount: 900,
          effectivePrice: 450,
          unitCost: 300,
          productDashboardPath: "/dashboard/products/product-1",
          inventoryDashboardPath: "/dashboard/inventory?location=delhi-1",
        },
      ],
      totalCandidateShelves: 1,
      truncated: false,
      storeDiscountCeilingPercent: 8,
      dataAsOf: "2026-09-02T00:01:00.000Z",
    });

    expect(result.candidates[0]).toMatchObject({
      daysOfCover: 300,
      sellThroughPercent: 9.1,
      grossMarginPercent: 33.3,
      reason: "excess_cover",
    });
    expect(result.promotionProposal).toMatchObject({
      status: "needs_terms",
      targetSkus: ["SKU10010007V028"],
      suggestedDiscountPercent: 8,
      budgetRequired: true,
      activationRequiresSeparateApproval: true,
    });
    expect(result.approvalBoundary.join(" ")).toContain(
      "did not create or activate an offer",
    );
  });

  it("withholds a discount when the store's own ceiling is zero", () => {
    // ★ 0 IS A REAL SETTING. `offers.maxTotalDiscountPercent` declares
    // `min: 0` and 0 means "stop offers discounting anything". Clamping with
    // Math.min alone turned that into an explicit 0% suggestion carrying a
    // note that claimed it preserved a five-point margin buffer — so the
    // store that locked discounting down hardest got the one nonsensical
    // recommendation.
    const result = buildSlowInventoryPromotionResult({
      storeName: "Echos",
      period: "30d",
      periodDays: 30,
      rangeLabel: "Last 30 days",
      fromInclusive: "2026-08-03T00:00:00.000Z",
      toExclusive: "2026-09-02T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      locationLabel: "Delhi",
      locationCount: 1,
      candidateShelves: [
        {
          productId: "product-1",
          variantId: "variant-1",
          productName: "Basmati Rice (Sample)",
          variantName: "5 kg",
          sku: "SKU10010007V028",
          locationId: "delhi-1",
          locationName: "Delhi",
          stock: 20,
          unitsSold: 2,
          salesAmount: 900,
          effectivePrice: 450,
          // Margin is known and generous, so the ONLY thing withholding the
          // suggestion is the store's ceiling.
          unitCost: 300,
          productDashboardPath: "/dashboard/products/product-1",
          inventoryDashboardPath: "/dashboard/inventory?location=delhi-1",
        },
      ],
      totalCandidateShelves: 1,
      truncated: false,
      storeDiscountCeilingPercent: 0,
      dataAsOf: "2026-09-02T00:01:00.000Z",
    });

    expect(result.candidates[0].grossMarginPercent).toBe(33.3);
    expect(result.promotionProposal.suggestedDiscountPercent).toBeNull();
    expect(result.promotionProposal.note).toContain("set to 0%");
    // The old clamp produced a "conservative 0% test" that claimed a buffer.
    expect(result.promotionProposal.note).not.toContain("0% test");
  });

  it("withholds a discount when cost data cannot prove the margin buffer", () => {
    const result = buildSlowInventoryPromotionResult({
      storeName: "Echos",
      period: "90d",
      periodDays: 90,
      rangeLabel: "Last 90 days",
      fromInclusive: "2026-06-04T00:00:00.000Z",
      toExclusive: "2026-09-02T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
      currency: "INR",
      locationLabel: "Shop",
      locationCount: 1,
      candidateShelves: [
        {
          productId: "product-2",
          variantId: null,
          productName: "Tomatoes (500 g) (Sample)",
          variantName: null,
          sku: "SKU100100015",
          locationId: "shop-1",
          locationName: "Shop",
          stock: 10,
          unitsSold: 0,
          salesAmount: 0,
          effectivePrice: 80,
          unitCost: null,
          productDashboardPath: "/dashboard/products/product-2",
          inventoryDashboardPath: "/dashboard/inventory?location=shop-1",
        },
      ],
      totalCandidateShelves: 1,
      truncated: false,
      storeDiscountCeilingPercent: 50,
      dataAsOf: "2026-09-02T00:01:00.000Z",
    });

    expect(result.candidates[0]).toMatchObject({
      daysOfCover: null,
      reason: "no_location_sales",
    });
    expect(result.promotionProposal.suggestedDiscountPercent).toBeNull();
    expect(result.promotionProposal.note).toContain("cost/margin data");
  });
});

describe("delayed pickup review result", () => {
  it("prepares only delay copy and preserves automatic reminder ownership", () => {
    const result = buildDelayedPickupReviewResult({
      locationLabel: "Shop and Delhi",
      locationCount: 2,
      timeZone: "Asia/Kolkata",
      reviewedAt: "2026-09-03T12:00:00.000Z",
      riskWindowHours: 48,
      pickups: [
        {
          orderRef: "ECH-1001",
          locationName: "Shop",
          pickupStatus: "awaiting",
          createdAt: "2026-09-01T08:00:00.000Z",
          promisedReadyAt: "2026-09-03T10:00:00.000Z",
          preparedAt: null,
          expiresAt: "2026-09-07T12:00:00.000Z",
          warnedAt: null,
          orderDashboardPath: "/dashboard/orders?q=ECH-1001",
        },
        {
          orderRef: "ECH-1002",
          locationName: "Delhi",
          pickupStatus: "awaiting",
          createdAt: "2026-09-02T08:00:00.000Z",
          promisedReadyAt: "2026-09-03T14:00:00.000Z",
          preparedAt: null,
          expiresAt: "2026-09-04T12:00:00.000Z",
          warnedAt: null,
          orderDashboardPath: "/dashboard/orders?q=ECH-1002",
        },
        {
          orderRef: "ECH-1003",
          locationName: "Shop",
          pickupStatus: "ready",
          createdAt: "2026-09-01T08:00:00.000Z",
          promisedReadyAt: "2026-09-02T08:00:00.000Z",
          preparedAt: "2026-09-02T09:00:00.000Z",
          expiresAt: "2026-09-04T08:00:00.000Z",
          warnedAt: null,
          orderDashboardPath: "/dashboard/orders?q=ECH-1003",
        },
        {
          orderRef: "ECH-1004",
          locationName: "Delhi",
          pickupStatus: "ready",
          createdAt: "2026-09-01T08:00:00.000Z",
          promisedReadyAt: "2026-09-02T08:00:00.000Z",
          preparedAt: "2026-09-02T09:00:00.000Z",
          expiresAt: "2026-09-04T10:00:00.000Z",
          warnedAt: "2026-09-03T11:00:00.000Z",
          orderDashboardPath: "/dashboard/orders?q=ECH-1004",
        },
      ],
      totalActionableOrders: 4,
      preparationOverdueCount: 1,
      preparationAtRiskCount: 1,
      collectionDueCount: 2,
      truncated: false,
      dataAsOf: "2026-09-03T12:00:00.000Z",
    });

    expect(result.pickups.map((pickup) => pickup.issue)).toEqual([
      "preparation_overdue",
      "preparation_at_risk",
      "collection_due",
      "collection_due",
    ]);
    expect(result.pickups[0]).toMatchObject({
      hoursPastPromise: 2,
      hoursUntilExpiry: 96,
      reminderState: "not_due",
    });
    expect(result.communications).toEqual([
      expect.objectContaining({
        kind: "preparation_delay",
        status: "prepared_for_review",
        orderReferences: ["ECH-1001", "ECH-1002"],
        subject: "Update on pickup order [order reference]",
      }),
      expect.objectContaining({
        kind: "automatic_collection_reminder",
        status: "automatic_reminder_pending",
        orderReferences: ["ECH-1003"],
        subject: null,
        body: null,
      }),
      expect.objectContaining({
        kind: "automatic_collection_reminder",
        status: "automatic_reminder_already_recorded",
        orderReferences: ["ECH-1004"],
        subject: null,
        body: null,
      }),
    ]);
    expect(result.safetyNotes.join(" ")).toContain(
      "names, email addresses, phone numbers, postal addresses and collection codes",
    );
  });
});
