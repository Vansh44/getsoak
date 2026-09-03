import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  getSalesAnalytics,
  getSalesByChannel,
  getSalesByLocation,
  getTopProducts,
} from "@/app/dashboard/analytics/data";
import {
  categories,
  inventoryLevels,
  products,
  productVariants,
  storeLocations,
  stores,
} from "@/drizzle/schema";
import type { AnalyticsRange } from "@/lib/analytics/range";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import { MinkToolInputError } from "./errors";
import type {
  ProductLaunchPreparationInput,
  ProductLaunchSnapshot,
  ProductLaunchSkuSnapshot,
  RevenueDeclineInvestigationInput,
  RevenueDeclineSnapshot,
  RevenueMetricSet,
  WeeklyTradingReportInput,
  WeeklyTradingReportSnapshot,
} from "./workflow-types";

const MAX_LAUNCH_SKUS = 20;

export interface WorkflowExecutionScope {
  locationIds: string[];
  locationLabel: string;
}

export interface ProductLaunchTarget {
  productId: string;
  variantId: string | null;
  sku: string;
}

export async function resolveProductLaunchTarget(
  storeId: string,
  rawSku: unknown,
): Promise<ProductLaunchTarget> {
  if (typeof rawSku !== "string") {
    throw new MinkToolInputError("product_sku must be an exact SKU string.");
  }
  const sku = rawSku.trim();
  if (!sku || sku.length > 100) {
    throw new MinkToolInputError(
      "product_sku must be between 1 and 100 characters.",
    );
  }
  const [productRows, variantRows] = await withService(async (db) =>
    Promise.all([
      db
        .select({ productId: products.id, sku: products.sku })
        .from(products)
        .where(and(eq(products.storeId, storeId), eq(products.sku, sku)))
        .limit(2),
      db
        .select({
          productId: productVariants.productId,
          variantId: productVariants.id,
          sku: productVariants.sku,
        })
        .from(productVariants)
        .innerJoin(
          products,
          and(
            eq(products.id, productVariants.productId),
            eq(products.storeId, storeId),
          ),
        )
        .where(
          and(
            eq(productVariants.storeId, storeId),
            eq(productVariants.sku, sku),
          ),
        )
        .limit(2),
    ]),
  );
  const matches = [
    ...productRows.map((row) => ({ ...row, variantId: null })),
    ...variantRows,
  ];
  if (matches.length !== 1) {
    throw new MinkToolInputError(
      matches.length === 0
        ? "product_sku does not match a product or variant in this store."
        : "product_sku is ambiguous; use one unique exact sellable SKU.",
    );
  }
  return matches[0];
}

export async function collectWeeklyTradingSnapshot(
  storeId: string,
  input: WeeklyTradingReportInput,
  scope: WorkflowExecutionScope,
): Promise<WeeklyTradingReportSnapshot> {
  const requestedAt = new Date(input.requestedAt);
  const range = parseAnalyticsRange(
    { range: "7d", compare: "previous" },
    input.timeZone,
    requestedAt,
  );
  const location = analyticsLocation(input, scope);
  const [sales, topProducts, channels] = await Promise.all([
    getSalesAnalytics(storeId, location, range, "all"),
    getTopProducts(storeId, location, range, 5),
    getSalesByChannel(storeId, location, range),
  ]);
  return {
    rangeLabel: sales.rangeLabel,
    comparisonLabel: sales.comparisonLabel,
    fromInclusive: range.current.from.toISOString(),
    toExclusive: range.current.to.toISOString(),
    timeZone: range.timeZone,
    currency: input.currency,
    locationLabel: scope.locationLabel,
    netSales: sales.totalSales.value,
    netSalesTrendPercent: sales.totalSales.trendPct,
    orders: sales.orders.value,
    ordersTrendPercent: sales.orders.trendPct,
    averageOrderValue: sales.averageOrderValue.value,
    averageOrderValueTrendPercent: sales.averageOrderValue.trendPct,
    unitsSold: sales.unitsSold.value,
    unitsSoldTrendPercent: sales.unitsSold.trendPct,
    topProducts: topProducts.map((product) => ({
      ...product,
      dashboardPath: `/dashboard/products/${product.id}`,
    })),
    channels,
    dataAsOf: new Date().toISOString(),
  };
}

export async function collectRevenueDeclineSnapshot(
  storeId: string,
  input: RevenueDeclineInvestigationInput,
  scope: WorkflowExecutionScope,
): Promise<RevenueDeclineSnapshot> {
  const requestedAt = new Date(input.requestedAt);
  const range = parseAnalyticsRange(
    { range: input.period, compare: "previous" },
    input.timeZone,
    requestedAt,
  );
  if (!range.compare || !range.comparisonLabel) {
    throw new Error("revenue_comparison_range_missing");
  }
  const currentRange = singleWindowRange(range, range.current, range.label);
  const previousRange = singleWindowRange(
    range,
    range.compare,
    range.comparisonLabel,
  );
  const location = analyticsLocation(input, scope);

  // Keep database fan-out bounded: four current-period reads, then four
  // comparison reads. This avoids a 15-worker heartbeat opening 120 queries at
  // once while still parallelising the independent evidence dimensions.
  const [currentSales, currentChannels, currentLocations, currentProducts] =
    await Promise.all([
      getSalesAnalytics(storeId, location, currentRange, "all"),
      getSalesByChannel(storeId, location, currentRange),
      getSalesByLocation(storeId, location, currentRange),
      getTopProducts(storeId, location, currentRange, 10),
    ]);
  const [previousSales, previousChannels, previousLocations, previousProducts] =
    await Promise.all([
      getSalesAnalytics(storeId, location, previousRange, "all"),
      getSalesByChannel(storeId, location, previousRange),
      getSalesByLocation(storeId, location, previousRange),
      getTopProducts(storeId, location, previousRange, 10),
    ]);

  return {
    period: input.period,
    rangeLabel: range.label,
    comparisonLabel: range.comparisonLabel,
    fromInclusive: range.current.from.toISOString(),
    toExclusive: range.current.to.toISOString(),
    comparisonFromInclusive: range.compare.from.toISOString(),
    comparisonToExclusive: range.compare.to.toISOString(),
    timeZone: range.timeZone,
    currency: input.currency,
    locationLabel: scope.locationLabel,
    current: salesMetrics(currentSales),
    previous: salesMetrics(previousSales),
    currentChannels,
    previousChannels,
    currentLocations: currentLocations.map((item) => ({
      ...item,
      dashboardPath: locationDashboardPath(item.key, input.period),
    })),
    previousLocations: previousLocations.map((item) => ({
      ...item,
      dashboardPath: locationDashboardPath(item.key, input.period),
    })),
    currentProducts: currentProducts.map((item) => ({
      ...item,
      dashboardPath: `/dashboard/products/${item.id}`,
    })),
    previousProducts: previousProducts.map((item) => ({
      ...item,
      dashboardPath: `/dashboard/products/${item.id}`,
    })),
    dataAsOf: new Date().toISOString(),
  };
}

export async function collectProductLaunchSnapshot(
  storeId: string,
  input: ProductLaunchPreparationInput,
  scope: WorkflowExecutionScope,
  defaultLowStockThreshold: number,
): Promise<ProductLaunchSnapshot> {
  return withService(async (db) => {
    const productRows = await db
      .select({
        storeName: stores.name,
        productId: products.id,
        productName: products.name,
        productSku: products.sku,
        status: products.status,
        categoryName: categories.name,
        featured: products.featured,
        description: products.description,
        seoTitle: products.seoTitle,
        seoDescription: products.seoDescription,
        imageUrl: products.imageUrl,
        images: products.images,
        basePrice: products.basePrice,
        sellingPrice: products.sellingPrice,
        trackInventory: products.trackInventory,
        lowStockThreshold: products.lowStockThreshold,
        requiresShipping: products.requiresShipping,
        weightGrams: products.weightGrams,
        lengthCm: products.lengthCm,
        widthCm: products.widthCm,
        heightCm: products.heightCm,
      })
      .from(products)
      .innerJoin(stores, eq(stores.id, products.storeId))
      .leftJoin(
        categories,
        and(
          eq(categories.id, products.categoryId),
          eq(categories.storeId, storeId),
        ),
      )
      .where(
        and(eq(products.id, input.productId), eq(products.storeId, storeId)),
      )
      .limit(1);
    const product = productRows[0];
    if (!product) throw new Error("workflow_product_target_missing");

    const variantRows = await db
      .select({
        id: productVariants.id,
        name: productVariants.name,
        sku: productVariants.sku,
        basePrice: productVariants.basePrice,
        sellingPrice: productVariants.sellingPrice,
        specialPrice: productVariants.specialPrice,
        imageUrl: productVariants.imageUrl,
        images: productVariants.images,
        trackInventory: productVariants.trackInventory,
        lowStockThreshold: productVariants.lowStockThreshold,
        requiresShipping: productVariants.requiresShipping,
        weightGrams: productVariants.weightGrams,
        lengthCm: productVariants.lengthCm,
        widthCm: productVariants.widthCm,
        heightCm: productVariants.heightCm,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.storeId, storeId),
          eq(productVariants.productId, product.productId),
          ...(input.variantId ? [eq(productVariants.id, input.variantId)] : []),
        ),
      )
      .orderBy(asc(productVariants.sortOrder), asc(productVariants.id))
      .limit(MAX_LAUNCH_SKUS + 1);
    if (input.variantId && variantRows.length !== 1) {
      throw new Error("workflow_variant_target_missing");
    }
    const variantsTruncated =
      !input.variantId && variantRows.length > MAX_LAUNCH_SKUS;
    const inspectedVariants = variantRows.slice(0, MAX_LAUNCH_SKUS);
    const variantIds = inspectedVariants.map((variant) => variant.id);
    const usesSimpleProduct =
      !input.variantId && inspectedVariants.length === 0;

    const [locations, levels] = await Promise.all([
      scope.locationIds.length === 0
        ? Promise.resolve([])
        : db
            .select({
              id: storeLocations.id,
              name: storeLocations.name,
              type: storeLocations.type,
            })
            .from(storeLocations)
            .where(
              and(
                eq(storeLocations.storeId, storeId),
                eq(storeLocations.active, true),
                inArray(storeLocations.id, scope.locationIds),
              ),
            )
            .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.name)),
      scope.locationIds.length === 0
        ? Promise.resolve([])
        : db
            .select({
              locationId: inventoryLevels.locationId,
              variantId: inventoryLevels.variantId,
              onHand: inventoryLevels.onHand,
            })
            .from(inventoryLevels)
            .where(
              and(
                eq(inventoryLevels.storeId, storeId),
                eq(inventoryLevels.productId, product.productId),
                inArray(inventoryLevels.locationId, scope.locationIds),
                usesSimpleProduct
                  ? isNull(inventoryLevels.variantId)
                  : inArray(inventoryLevels.variantId, variantIds),
              ),
            ),
    ]);
    const locationStocksFor = (variantId: string | null) =>
      locations.map((location) => ({
        locationId: location.id,
        locationName: location.name,
        stock: levels
          .filter(
            (level) =>
              level.variantId === variantId && level.locationId === location.id,
          )
          .reduce((sum, level) => sum + Number(level.onHand), 0),
      }));
    const skuStock = (
      variantId: string | null,
    ): Pick<ProductLaunchSkuSnapshot, "totalStock" | "locationStocks"> => {
      const locationStocks = locationStocksFor(variantId);
      return {
        locationStocks,
        totalStock: locationStocks.reduce(
          (sum, location) => sum + location.stock,
          0,
        ),
      };
    };
    const skus: ProductLaunchSkuSnapshot[] = usesSimpleProduct
      ? [
          {
            productId: product.productId,
            variantId: null,
            productName: product.productName,
            variantName: null,
            sku: product.productSku,
            basePrice: Number(product.basePrice),
            sellingPrice: Number(product.sellingPrice),
            specialPrice: null,
            trackInventory: product.trackInventory,
            lowStockThreshold:
              product.lowStockThreshold ?? defaultLowStockThreshold,
            ...skuStock(null),
            requiresShipping: product.requiresShipping,
            shippingMeasurementsComplete: completeMeasurements(product),
            dashboardPath: `/dashboard/products/${product.productId}`,
          },
        ]
      : inspectedVariants.map((variant) => ({
          productId: product.productId,
          variantId: variant.id,
          productName: product.productName,
          variantName: variant.name,
          sku: variant.sku,
          basePrice: Number(variant.basePrice),
          sellingPrice: Number(variant.sellingPrice),
          specialPrice:
            variant.specialPrice == null ? null : Number(variant.specialPrice),
          trackInventory: variant.trackInventory,
          lowStockThreshold:
            variant.lowStockThreshold ?? defaultLowStockThreshold,
          ...skuStock(variant.id),
          requiresShipping:
            variant.requiresShipping ?? product.requiresShipping,
          shippingMeasurementsComplete: completeMeasurements({
            weightGrams: variant.weightGrams ?? product.weightGrams,
            lengthCm: variant.lengthCm ?? product.lengthCm,
            widthCm: variant.widthCm ?? product.widthCm,
            heightCm: variant.heightCm ?? product.heightCm,
          }),
          dashboardPath: `/dashboard/products/${product.productId}`,
        }));
    const requestedVariantName = input.variantId
      ? (inspectedVariants[0]?.name ?? null)
      : null;

    return {
      storeName: product.storeName,
      productId: product.productId,
      productName: product.productName,
      requestedSku: input.requestedSku,
      requestedVariantName,
      status: product.status,
      categoryName: product.categoryName,
      featured: product.featured,
      descriptionLength: normalizedLength(product.description),
      seoTitleLength: normalizedLength(product.seoTitle),
      seoDescriptionLength: normalizedLength(product.seoDescription),
      imageCount: uniqueImageCount(
        [product.imageUrl, ...product.images],
        inspectedVariants.flatMap((variant) => [
          variant.imageUrl,
          ...variant.images,
        ]),
      ),
      variantsTruncated,
      locationLabel: scope.locationLabel,
      timeZone: input.timeZone,
      currency: input.currency,
      skus,
      locationStock: locations.map((location) => ({
        ...location,
        stock: levels
          .filter((level) => level.locationId === location.id)
          .reduce((sum, level) => sum + Number(level.onHand), 0),
        dashboardPath: `/dashboard/inventory?location=${encodeURIComponent(location.id)}`,
      })),
      dataAsOf: new Date().toISOString(),
      productDashboardPath: `/dashboard/products/${product.productId}`,
      inventoryDashboardPath: "/dashboard/inventory",
    };
  });
}

function analyticsLocation(
  input: WeeklyTradingReportInput | RevenueDeclineInvestigationInput,
  scope: WorkflowExecutionScope,
) {
  return {
    locationIds: scope.locationIds,
    selectedId: null,
    includeUnassigned: input.includeUnassigned,
  };
}

function singleWindowRange(
  source: AnalyticsRange,
  current: AnalyticsRange["current"],
  label: string,
): AnalyticsRange {
  return {
    ...source,
    comparison: "none",
    current,
    compare: null,
    label,
    comparisonLabel: null,
  };
}

function salesMetrics(
  sales: Awaited<ReturnType<typeof getSalesAnalytics>>,
): RevenueMetricSet {
  return {
    netSales: sales.totalSales.value,
    orders: sales.orders.value,
    averageOrderValue: sales.averageOrderValue.value,
    unitsSold: sales.unitsSold.value,
  };
}

function locationDashboardPath(key: string, period: string): string {
  return key === "online"
    ? `/dashboard/analytics?range=${period}&compare=previous`
    : `/dashboard/analytics?range=${period}&compare=previous&location=${encodeURIComponent(key)}`;
}

function completeMeasurements(value: {
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
}): boolean {
  return (
    Number(value.weightGrams) > 0 &&
    Number(value.lengthCm) > 0 &&
    Number(value.widthCm) > 0 &&
    Number(value.heightCm) > 0
  );
}

function normalizedLength(value: string | null): number {
  return value?.trim().length ?? 0;
}

function uniqueImageCount(...groups: Array<Array<string | null>>): number {
  return new Set(
    groups
      .flat()
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  ).size;
}
