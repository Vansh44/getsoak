import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  getSalesAnalytics,
  getSalesByChannel,
  getSalesByLocation,
  getTopProducts,
  orderWindow,
  recognizedOrder,
} from "@/app/dashboard/analytics/data";
import {
  categories,
  inventoryLevels,
  orderItems,
  orders,
  products,
  productVariants,
  storeLocations,
  stores,
} from "@/drizzle/schema";
import type { AnalyticsRange } from "@/lib/analytics/range";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import { PICKUP_WARN_HOURS } from "@/lib/pos/collection-state";
import { MinkToolInputError } from "./errors";
import type {
  DelayedPickupReviewInput,
  DelayedPickupSnapshot,
  DelayedPickupSnapshotItem,
  ProductLaunchPreparationInput,
  ProductLaunchSnapshot,
  ProductLaunchSkuSnapshot,
  RevenueDeclineInvestigationInput,
  RevenueDeclineSnapshot,
  RevenueMetricSet,
  SlowInventoryPromotionInput,
  SlowInventoryShelfSnapshot,
  SlowInventorySnapshot,
  WeeklyTradingReportInput,
  WeeklyTradingReportSnapshot,
} from "./workflow-types";

const MAX_LAUNCH_SKUS = 20;
const MAX_SLOW_INVENTORY_CANDIDATES = 20;
const MAX_DELAYED_PICKUPS = 25;

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

type SlowInventoryQueryRow = {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  locationId: string;
  locationName: string;
  stock: number | string;
  unitsSold: number | string;
  salesAmount: number | string;
  effectivePrice: number | string;
  unitCost: number | string | null;
  totalMatches: number | string;
};

type DelayedPickupQueryRow = {
  orderRef: string;
  locationName: string;
  pickupStatus: "awaiting" | "ready";
  createdAt: string | Date;
  promisedReadyAt: string | Date | null;
  preparedAt: string | Date | null;
  expiresAt: string | Date;
  warnedAt: string | Date | null;
  totalMatches: number | string;
  preparationOverdueCount: number | string;
  preparationAtRiskCount: number | string;
  collectionDueCount: number | string;
};

/**
 * Find slow stock at the shelf where it can actually be moved. The query is
 * deliberately one bounded database statement: it never pulls an unbounded
 * catalogue into a worker, and it cannot hide a dead Shop shelf behind Delhi
 * stock (or vice versa).
 */
export async function collectSlowInventorySnapshot(
  storeId: string,
  input: SlowInventoryPromotionInput,
  scope: WorkflowExecutionScope,
): Promise<SlowInventorySnapshot> {
  const requestedAt = new Date(input.requestedAt);
  const range = parseAnalyticsRange(
    { range: input.period, compare: "none" },
    input.timeZone,
    requestedAt,
  );
  const periodDays = input.period === "90d" ? 90 : 30;
  const exposureCutoff = range.current.from.toISOString();

  return withService(async (db) => {
    const [storeRows, queryResult] = await Promise.all([
      db
        .select({ name: stores.name, settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
      scope.locationIds.length === 0
        ? Promise.resolve({ rows: [] as SlowInventoryQueryRow[] })
        : db.execute(sql<SlowInventoryQueryRow>`
            WITH shelf AS (
              SELECT
                ${products.id} AS "productId",
                ${inventoryLevels.variantId} AS "variantId",
                ${products.name} AS "productName",
                ${productVariants.name} AS "variantName",
                COALESCE(${productVariants.sku}, ${products.sku}) AS sku,
                ${inventoryLevels.locationId} AS "locationId",
                ${storeLocations.name} AS "locationName",
                ${inventoryLevels.onHand}::int AS stock,
                COALESCE(
                  NULLIF(${productVariants.specialPrice}, 0),
                  ${productVariants.sellingPrice},
                  ${products.sellingPrice}
                )::numeric AS "effectivePrice",
                COALESCE(${productVariants.costPrice}, ${products.costPrice})::numeric AS "unitCost"
              FROM ${inventoryLevels}
              INNER JOIN ${products}
                ON ${products.id} = ${inventoryLevels.productId}
               AND ${products.storeId} = ${inventoryLevels.storeId}
              LEFT JOIN ${productVariants}
                ON ${productVariants.id} = ${inventoryLevels.variantId}
               AND ${productVariants.productId} = ${products.id}
               AND ${productVariants.storeId} = ${inventoryLevels.storeId}
              INNER JOIN ${storeLocations}
                ON ${storeLocations.id} = ${inventoryLevels.locationId}
               AND ${storeLocations.storeId} = ${inventoryLevels.storeId}
              WHERE ${inventoryLevels.storeId} = ${storeId}::uuid
                AND ${inArray(inventoryLevels.locationId, scope.locationIds)}
                AND ${storeLocations.active} = true
                AND ${products.status} = 'published'
                AND COALESCE(${products.publishedAt}, ${products.createdAt}) <= ${exposureCutoff}::timestamptz
                AND ${inventoryLevels.onHand} > 0
                AND (
                  (${inventoryLevels.variantId} IS NULL AND ${products.trackInventory} = true)
                  OR
                  (${inventoryLevels.variantId} IS NOT NULL AND ${productVariants.trackInventory} = true)
                )
            ),
            sold AS (
              SELECT
                ${orderItems.productId} AS "productId",
                ${orderItems.variantId} AS "variantId",
                ${orders.locationId} AS "locationId",
                COALESCE(SUM(${orderItems.quantity}), 0)::int AS "unitsSold",
                COALESCE(SUM(${orderItems.total}), 0)::numeric AS "salesAmount"
              FROM ${orderItems}
              INNER JOIN ${orders} ON ${orders.id} = ${orderItems.orderId}
              WHERE ${orders.storeId} = ${storeId}::uuid
                AND ${inArray(orders.locationId, scope.locationIds)}
                AND ${recognizedOrder()}
                AND ${orderWindow(range.current)}
              GROUP BY ${orderItems.productId}, ${orderItems.variantId}, ${orders.locationId}
            ),
            candidates AS (
              SELECT
                shelf.*,
                COALESCE(sold."unitsSold", 0)::int AS "unitsSold",
                COALESCE(sold."salesAmount", 0)::numeric AS "salesAmount"
              FROM shelf
              LEFT JOIN sold
                ON sold."productId" = shelf."productId"
               AND sold."variantId" IS NOT DISTINCT FROM shelf."variantId"
               AND sold."locationId" = shelf."locationId"
              WHERE COALESCE(sold."unitsSold", 0) = 0
                 OR shelf.stock >= (COALESCE(sold."unitsSold", 0) * 2)
            )
            SELECT candidates.*, COUNT(*) OVER ()::int AS "totalMatches"
            FROM candidates
            ORDER BY
              CASE WHEN "unitsSold" = 0 THEN 0 ELSE 1 END,
              CASE
                WHEN "unitsSold" = 0 THEN NULL
                ELSE (stock::numeric / "unitsSold"::numeric)
              END DESC NULLS FIRST,
              stock DESC,
              "locationName" ASC,
              sku ASC
            LIMIT ${MAX_SLOW_INVENTORY_CANDIDATES}
          `),
    ]);
    const store = storeRows[0];
    if (!store) throw new Error("workflow_store_missing");
    const rows = queryResult.rows as unknown as SlowInventoryQueryRow[];
    const candidateShelves: SlowInventoryShelfSnapshot[] = rows.map((row) => ({
      productId: row.productId,
      variantId: row.variantId,
      productName: row.productName,
      variantName: row.variantName,
      sku: row.sku,
      locationId: row.locationId,
      locationName: row.locationName,
      stock: Number(row.stock),
      unitsSold: Number(row.unitsSold),
      salesAmount: Number(row.salesAmount),
      effectivePrice: Number(row.effectivePrice),
      unitCost: row.unitCost == null ? null : Number(row.unitCost),
      productDashboardPath: `/dashboard/products/${row.productId}`,
      inventoryDashboardPath: `/dashboard/inventory?location=${encodeURIComponent(row.locationId)}`,
    }));
    const totalCandidateShelves = Number(rows[0]?.totalMatches ?? 0);

    return {
      storeName: store.name,
      period: input.period,
      periodDays,
      rangeLabel: range.label,
      fromInclusive: range.current.from.toISOString(),
      toExclusive: range.current.to.toISOString(),
      timeZone: range.timeZone,
      currency: input.currency,
      locationLabel: scope.locationLabel,
      locationCount: scope.locationIds.length,
      candidateShelves,
      totalCandidateShelves,
      truncated: totalCandidateShelves > candidateShelves.length,
      storeDiscountCeilingPercent: readStoreDiscountCeiling(store.settings),
      dataAsOf: new Date().toISOString(),
    };
  });
}

/**
 * Review only currently actionable pickup orders. This intentionally excludes
 * every customer/contact field and collection code: a background operational
 * report does not need PII or a counter credential to identify an order.
 * Existing expiry/reminder sweeps remain the only writers of pickup state.
 */
export async function collectDelayedPickupSnapshot(
  storeId: string,
  input: DelayedPickupReviewInput,
  scope: WorkflowExecutionScope,
): Promise<DelayedPickupSnapshot> {
  const reviewedAt = new Date().toISOString();
  if (scope.locationIds.length === 0) {
    return {
      locationLabel: scope.locationLabel,
      locationCount: 0,
      timeZone: input.timeZone,
      reviewedAt,
      riskWindowHours: PICKUP_WARN_HOURS,
      pickups: [],
      totalActionableOrders: 0,
      preparationOverdueCount: 0,
      preparationAtRiskCount: 0,
      collectionDueCount: 0,
      truncated: false,
      dataAsOf: reviewedAt,
    };
  }

  const queryResult = await withService((db) =>
    db.execute(sql<DelayedPickupQueryRow>`
      WITH actionable AS (
        SELECT
          ${orders.orderRef} AS "orderRef",
          ${storeLocations.name} AS "locationName",
          ${orders.pickupStatus} AS "pickupStatus",
          ${orders.createdAt} AS "createdAt",
          ${orders.pickupReadyAt} AS "promisedReadyAt",
          ${orders.pickupPreparedAt} AS "preparedAt",
          ${orders.pickupExpiresAt} AS "expiresAt",
          ${orders.pickupWarnedAt} AS "warnedAt"
        FROM ${orders}
        INNER JOIN ${storeLocations}
          ON ${storeLocations.id} = ${orders.pickupLocationId}
         AND ${storeLocations.storeId} = ${orders.storeId}
         AND ${storeLocations.active} = true
        WHERE ${orders.storeId} = ${storeId}::uuid
          AND ${orders.fulfilmentType} = 'pickup'
          AND ${inArray(orders.pickupLocationId, scope.locationIds)}
          AND ${orders.pickupStatus} IN ('awaiting', 'ready')
          AND ${orders.status} <> 'cancelled'
          AND ${orders.paymentStatus} <> 'refunded'
          AND ${orders.pickupExpiresAt} > ${reviewedAt}::timestamptz
          AND (
            (
              ${orders.pickupStatus} = 'awaiting'
              AND ${orders.pickupReadyAt} IS NOT NULL
              AND ${orders.pickupReadyAt} <= ${reviewedAt}::timestamptz
            )
            OR ${orders.pickupExpiresAt} <= (
              ${reviewedAt}::timestamptz
              + make_interval(hours => ${PICKUP_WARN_HOURS})
            )
          )
      )
      SELECT
        actionable.*,
        COUNT(*) OVER ()::int AS "totalMatches",
        COUNT(*) FILTER (
          WHERE "pickupStatus" = 'awaiting'
            AND "promisedReadyAt" IS NOT NULL
            AND "promisedReadyAt" <= ${reviewedAt}::timestamptz
        ) OVER ()::int AS "preparationOverdueCount",
        COUNT(*) FILTER (
          WHERE "pickupStatus" = 'awaiting'
            AND (
              "promisedReadyAt" IS NULL
              OR "promisedReadyAt" > ${reviewedAt}::timestamptz
            )
        ) OVER ()::int AS "preparationAtRiskCount",
        COUNT(*) FILTER (
          WHERE "pickupStatus" = 'ready'
        ) OVER ()::int AS "collectionDueCount"
      FROM actionable
      ORDER BY
        CASE
          WHEN "expiresAt" <= ${reviewedAt}::timestamptz + interval '24 hours' THEN 0
          WHEN "pickupStatus" = 'awaiting'
            AND "promisedReadyAt" <= ${reviewedAt}::timestamptz THEN 1
          ELSE 2
        END,
        "expiresAt" ASC,
        "createdAt" ASC,
        "orderRef" ASC
      LIMIT ${MAX_DELAYED_PICKUPS}
    `),
  );
  const rows = queryResult.rows as unknown as DelayedPickupQueryRow[];
  const pickups: DelayedPickupSnapshotItem[] = rows.map((row) => ({
    orderRef: row.orderRef,
    locationName: row.locationName,
    pickupStatus: row.pickupStatus,
    createdAt: requiredIsoTimestamp(row.createdAt),
    promisedReadyAt: optionalIsoTimestamp(row.promisedReadyAt),
    preparedAt: optionalIsoTimestamp(row.preparedAt),
    expiresAt: requiredIsoTimestamp(row.expiresAt),
    warnedAt: optionalIsoTimestamp(row.warnedAt),
    orderDashboardPath: `/dashboard/orders?q=${encodeURIComponent(row.orderRef)}`,
  }));
  const totalActionableOrders = Number(rows[0]?.totalMatches ?? 0);
  return {
    locationLabel: scope.locationLabel,
    locationCount: scope.locationIds.length,
    timeZone: input.timeZone,
    reviewedAt,
    riskWindowHours: PICKUP_WARN_HOURS,
    pickups,
    totalActionableOrders,
    preparationOverdueCount: Number(rows[0]?.preparationOverdueCount ?? 0),
    preparationAtRiskCount: Number(rows[0]?.preparationAtRiskCount ?? 0),
    collectionDueCount: Number(rows[0]?.collectionDueCount ?? 0),
    truncated: totalActionableOrders > pickups.length,
    dataAsOf: reviewedAt,
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

function optionalIsoTimestamp(value: string | Date | null): string | null {
  if (value == null) return null;
  return requiredIsoTimestamp(value);
}

function requiredIsoTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("workflow_pickup_timestamp_invalid");
  }
  return date.toISOString();
}

function readStoreDiscountCeiling(value: unknown): number {
  const settings =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const features =
    settings.features &&
    typeof settings.features === "object" &&
    !Array.isArray(settings.features)
      ? (settings.features as Record<string, unknown>)
      : {};
  const configured = features["offers.maxTotalDiscountPercent"];
  return typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0 &&
    configured <= 100
    ? configured
    : 50;
}
