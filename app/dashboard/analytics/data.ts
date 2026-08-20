import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  blogs,
  categories,
  enquiries,
  orderItems,
  orderPayments,
  orderRefunds,
  orderReturnItems,
  orderReturns,
  orders,
  products,
  stockMovements,
  storeLocations,
  users,
} from "@/drizzle/schema";
import type {
  AnalyticsLocationOption,
  AnalyticsLocationSelection,
} from "@/lib/analytics/location";
import type { AnalyticsRange, AnalyticsWindow } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import type { LocationScope } from "@/lib/locations/scope";

export interface Stat {
  value: number;
  /** Null means there is no meaningful comparison (disabled or zero baseline). */
  trendPct: number | null;
  trendUp: boolean;
  spark: number[];
}

export interface SalesPoint {
  key: string;
  label: string;
  /** Raw store-currency units; never rounded to thousands. */
  sales: number;
  orders: number;
  units: number;
}

export interface SalesAnalytics {
  totalSales: Stat;
  orders: Stat;
  averageOrderValue: Stat;
  unitsSold: Stat;
  series: SalesPoint[];
  rangeLabel: string;
  comparisonLabel: string | null;
}

export interface CatalogSnapshots {
  customers: Stat;
  products: Stat;
}

export interface TopCategory {
  name: string;
  amount: number;
  share: number;
}

export interface TopProduct {
  id: string;
  name: string;
  units: number;
  amount: number;
}

export interface CommerceBreakdown {
  key: string;
  name: string;
  amount: number;
  orders: number;
  share: number;
}

export interface CustomerMix {
  newCustomers: number;
  returningCustomers: number;
  totalCustomers: number;
}

export interface DiscountImpact {
  orderDiscounts: number;
  lineDiscounts: number;
  totalDiscounts: number;
  couponOrders: number;
}

export interface ReturnsAndRefunds {
  completedReturns: number;
  returnedUnits: number;
  returnedValue: number;
  completedRefunds: number;
}

export interface InventoryVelocityItem {
  id: string;
  name: string;
  units: number;
}

export interface RecentOrder {
  ref: string;
  name: string;
  total: number;
  status: string;
  createdAt: string;
}

export interface ActivityItem {
  kind: "order" | "enquiry" | "blog";
  who: string | null;
  detail: string;
  createdAt: string;
}

export const RECOGNIZED_PAYMENT_STATUSES = [
  "paid",
  "partially_refunded",
  "refunded",
] as const;
export const RECOGNIZED_POS_STATUSES = ["completed", "refunded"] as const;

export function locationCondition(
  selection: AnalyticsLocationSelection,
): SQL | undefined {
  if (selection.locationIds === null) return undefined;
  const physical =
    selection.locationIds.length > 0
      ? inArray(orders.locationId, selection.locationIds)
      : sql`false`;
  // Aggregate accessible views include online/unrouted orders. Selecting one
  // physical shop is intentionally exact and excludes those NULL rows.
  return selection.includeUnassigned
    ? or(isNull(orders.locationId), physical)
    : physical;
}

function inventoryLocationCondition(
  selection: AnalyticsLocationSelection,
): SQL | undefined {
  if (selection.locationIds === null) return undefined;
  const physical =
    selection.locationIds.length > 0
      ? inArray(stockMovements.locationId, selection.locationIds)
      : sql`false`;
  return selection.includeUnassigned
    ? or(isNull(stockMovements.locationId), physical)
    : physical;
}

export async function getAnalyticsLocationOptions(
  storeId: string,
  viewerScope: LocationScope,
): Promise<AnalyticsLocationOption[]> {
  const rows = await withService((db) =>
    db
      .select({ id: storeLocations.id, name: storeLocations.name })
      .from(storeLocations)
      .where(eq(storeLocations.storeId, storeId))
      .orderBy(storeLocations.sortOrder, storeLocations.name),
  );
  if (viewerScope === null) return rows;
  const allowed = new Set(viewerScope);
  return rows.filter((row) => allowed.has(row.id));
}

/** The single recognized-sale contract shared by all Phase 1 commerce cards. */
export function recognizedOrder(): SQL {
  return and(
    ne(orders.status, "cancelled"),
    or(
      eq(orders.paymentMethod, "cash_on_delivery"),
      inArray(orders.paymentStatus, [...RECOGNIZED_PAYMENT_STATUSES]),
      and(
        eq(orders.salesChannel, "pos"),
        inArray(orders.status, [...RECOGNIZED_POS_STATUSES]),
      ),
    ),
  ) as SQL;
}

export function orderWindow(window: AnalyticsWindow): SQL {
  return and(
    gte(orders.createdAt, window.from.toISOString()),
    lt(orders.createdAt, window.to.toISOString()),
  ) as SQL;
}

export function refundWindow(window: AnalyticsWindow): SQL {
  return and(
    gte(orderRefunds.createdAt, window.from.toISOString()),
    lt(orderRefunds.createdAt, window.to.toISOString()),
  ) as SQL;
}

export function comparisonTrend(
  current: number,
  previous: number | null,
): Pick<Stat, "trendPct" | "trendUp"> {
  if (previous === null || previous === 0) {
    return { trendPct: null, trendUp: current >= 0 };
  }
  return {
    trendPct:
      Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10,
    trendUp: current >= previous,
  };
}

function grainFor(window: AnalyticsWindow): "day" | "week" | "month" {
  const days = (window.to.getTime() - window.from.getTime()) / 86_400_000;
  if (days <= 45) return "day";
  if (days <= 210) return "week";
  return "month";
}

function pointLabel(key: string, grain: "day" | "week" | "month") {
  const date = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-IN", {
    day: grain === "month" ? undefined : "numeric",
    month: "short",
    year: grain === "month" ? "2-digit" : undefined,
    timeZone: "UTC",
  }).format(date);
}

export async function getSalesAnalytics(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<SalesAnalytics> {
  const scoped = locationCondition(location);
  const grain = grainFor(range.current);

  return withService(async (db) => {
    const totalsFor = async (window: AnalyticsWindow) => {
      const [orderRow] = await db
        .select({
          sales: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
          count: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, storeId),
            recognizedOrder(),
            orderWindow(window),
            ...(scoped ? [scoped] : []),
          ),
        );
      const [refundRow] = await db
        .select({
          refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
        })
        .from(orderRefunds)
        .innerJoin(
          orders,
          and(
            eq(orders.id, orderRefunds.orderId),
            eq(orders.storeId, storeId),
            ...(scoped ? [scoped] : []),
          ),
        )
        .where(
          and(
            eq(orderRefunds.storeId, storeId),
            eq(orderRefunds.status, "completed"),
            refundWindow(window),
          ),
        );
      const [unitRow] = await db
        .select({
          units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
        })
        .from(orderItems)
        .innerJoin(
          orders,
          and(
            eq(orders.id, orderItems.orderId),
            eq(orders.storeId, storeId),
            recognizedOrder(),
            orderWindow(window),
            ...(scoped ? [scoped] : []),
          ),
        );
      return {
        sales: Number(orderRow?.sales ?? 0) - Number(refundRow?.refunds ?? 0),
        orders: Number(orderRow?.count ?? 0),
        units: Number(unitRow?.units ?? 0),
      };
    };

    const bucket = sql`date_trunc(${grain}, ${orders.createdAt} at time zone ${range.timeZone})`;
    const refundBucket = sql`date_trunc(${grain}, ${orderRefunds.createdAt} at time zone ${range.timeZone})`;
    const current = await totalsFor(range.current);
    const previous = range.compare ? await totalsFor(range.compare) : null;
    const orderRows = await db
      .select({
        key: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
        sales: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        count: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      // Reusing `bucket` here produces fresh bind placeholders in Drizzle, so
      // PostgreSQL no longer sees the GROUP BY expression as the selected one.
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const refundRows = await db
      .select({
        key: sql<string>`to_char(${refundBucket}, 'YYYY-MM-DD')`,
        refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const unitRows = await db
      .select({
        key: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
        units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderItems.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const points = new Map<
      string,
      { sales: number; orders: number; units: number }
    >();
    for (const row of orderRows) {
      points.set(row.key, {
        sales: Number(row.sales),
        orders: Number(row.count),
        units: 0,
      });
    }
    for (const row of refundRows) {
      const point = points.get(row.key) ?? { sales: 0, orders: 0, units: 0 };
      point.sales -= Number(row.refunds);
      points.set(row.key, point);
    }
    for (const row of unitRows) {
      const point = points.get(row.key) ?? { sales: 0, orders: 0, units: 0 };
      point.units = Number(row.units);
      points.set(row.key, point);
    }
    const series = [...points.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, point]) => ({
        key,
        label: pointLabel(key, grain),
        ...point,
      }));

    return {
      totalSales: {
        value: current.sales,
        ...comparisonTrend(current.sales, previous?.sales ?? null),
        spark: series.map((point) => point.sales),
      },
      orders: {
        value: current.orders,
        ...comparisonTrend(current.orders, previous?.orders ?? null),
        spark: series.map((point) => point.orders),
      },
      averageOrderValue: {
        value: current.orders > 0 ? current.sales / current.orders : 0,
        ...comparisonTrend(
          current.orders > 0 ? current.sales / current.orders : 0,
          previous && previous.orders > 0
            ? previous.sales / previous.orders
            : null,
        ),
        spark: series.map((point) =>
          point.orders > 0 ? point.sales / point.orders : 0,
        ),
      },
      unitsSold: {
        value: current.units,
        ...comparisonTrend(current.units, previous?.units ?? null),
        spark: series.map((point) => point.units),
      },
      series,
      rangeLabel: range.label,
      comparisonLabel: range.comparisonLabel,
    };
  });
}

export async function getCatalogSnapshots(
  storeId: string,
): Promise<CatalogSnapshots> {
  return withService(async (db) => {
    const [customers] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.storeId, storeId));
    const [published] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(
        and(eq(products.storeId, storeId), eq(products.status, "published")),
      );
    const snapshot = (value: number): Stat => ({
      value,
      trendPct: null,
      trendUp: true,
      spark: [],
    });
    return {
      customers: snapshot(Number(customers?.count ?? 0)),
      products: snapshot(Number(published?.count ?? 0)),
    };
  });
}

export async function getTopCategories(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<TopCategory[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const earnedRows = await db
      .select({
        name: sql<string>`coalesce(${categories.name}, 'Uncategorized')`,
        amount: sql<number>`coalesce(sum(${orderItems.total}), 0)::float8`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderItems.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .leftJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .groupBy(sql`coalesce(${categories.name}, 'Uncategorized')`)
      .orderBy(desc(sql`coalesce(sum(${orderItems.total}), 0)`));
    const categoryRows = await db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.storeId, storeId));
    const earned = new Map(
      earnedRows.map((row) => [row.name, Number(row.amount)]),
    );
    const total = earnedRows.reduce((sum, row) => sum + Number(row.amount), 0);
    const names = categoryRows
      .map((row) => row.name)
      .filter(Boolean) as string[];
    if ((earned.get("Uncategorized") ?? 0) > 0) names.push("Uncategorized");
    return names
      .map((name) => ({ name, amount: earned.get(name) ?? 0 }))
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
      .map((item) => ({
        ...item,
        share: total > 0 ? Math.round((item.amount / total) * 100) : 0,
      }));
  });
}

export async function getTopProducts(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
  limit = 10,
): Promise<TopProduct[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const rows = await db
      .select({
        id: orderItems.productId,
        name: sql<string>`max(${orderItems.name})`,
        units: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`,
        amount: sql<number>`coalesce(sum(${orderItems.total}), 0)::float8`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderItems.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`coalesce(sum(${orderItems.quantity}), 0)`))
      .limit(Math.max(1, Math.min(limit, 10_000)));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      units: Number(row.units),
      amount: Number(row.amount),
    }));
  });
}

function channelName(key: string): string {
  if (key === "pos") return "Point of sale";
  if (key === "online") return "Online store";
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function finalizeBreakdown(
  earnedRows: Array<{
    key: string;
    name: string;
    amount: number;
    orders: number;
  }>,
  refundRows: Array<{ key: string; name?: string; refunds: number }>,
): CommerceBreakdown[] {
  const net = new Map(
    earnedRows.map((row) => [
      row.key,
      {
        key: row.key,
        name: row.name,
        amount: Number(row.amount),
        orders: Number(row.orders),
      },
    ]),
  );
  for (const refund of refundRows) {
    const row = net.get(refund.key) ?? {
      key: refund.key,
      name: refund.name ?? refund.key,
      amount: 0,
      orders: 0,
    };
    row.amount -= Number(refund.refunds);
    net.set(refund.key, row);
  }
  const rows = [...net.values()];
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return rows
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
    .map((row) => ({
      ...row,
      share:
        total > 0 ? Math.max(0, Math.round((row.amount / total) * 100)) : 0,
    }));
}

export async function getSalesByChannel(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CommerceBreakdown[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const earnedRows = await db
      .select({
        key: orders.salesChannel,
        amount: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orders.salesChannel);
    const refundRows = await db
      .select({
        key: orders.salesChannel,
        refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      )
      .groupBy(orders.salesChannel);
    return finalizeBreakdown(
      earnedRows.map((row) => ({ ...row, name: channelName(row.key) })),
      refundRows.map((row) => ({ ...row, name: channelName(row.key) })),
    );
  });
}

export async function getSalesByLocation(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CommerceBreakdown[]> {
  const scoped = locationCondition(location);
  const key = sql<string>`coalesce(${orders.locationId}::text, 'online')`;
  const name = sql<string>`coalesce(${storeLocations.name}, 'Online / unassigned')`;
  return withService(async (db) => {
    const earnedRows = await db
      .select({
        key,
        name,
        amount: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .leftJoin(
        storeLocations,
        and(
          eq(storeLocations.id, orders.locationId),
          eq(storeLocations.storeId, storeId),
        ),
      )
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(key, name);
    const refundRows = await db
      .select({
        key,
        name,
        refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          ...(scoped ? [scoped] : []),
        ),
      )
      .leftJoin(
        storeLocations,
        and(
          eq(storeLocations.id, orders.locationId),
          eq(storeLocations.storeId, storeId),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      )
      .groupBy(key, name);
    return finalizeBreakdown(earnedRows, refundRows);
  });
}

function paymentMethodName(key: string): string {
  const known: Record<string, string> = {
    cash: "Cash",
    card: "Card terminal",
    upi: "UPI",
    razorpay: "Razorpay",
    store_credit: "Store credit",
    gift_card: "Gift card",
    cash_on_delivery: "Cash on delivery",
    pay_at_store: "Pay at store",
    manual: "Manual refund",
  };
  return known[key] ?? channelName(key);
}

interface PaymentAmountRow {
  key: string;
  amount: number;
  orders: number;
}

export function buildPaymentBreakdown(input: {
  pos: PaymentAmountRow[];
  online: PaymentAmountRow[];
  storeCredit: { amount: number; orders: number } | null;
  refunds: Array<{ key: string; refunds: number }>;
}): CommerceBreakdown[] {
  const earned = new Map<
    string,
    { key: string; name: string; amount: number; orders: number }
  >();
  const add = (key: string, amount: number, orderCount: number) => {
    // `split` is only an order-level summary. Valid POS rows are itemized above
    // and valid online rows retain their actual gateway/COD method.
    if (key === "split") return;
    const row = earned.get(key) ?? {
      key,
      name: paymentMethodName(key),
      amount: 0,
      orders: 0,
    };
    row.amount += Number(amount);
    row.orders += Number(orderCount);
    earned.set(key, row);
  };
  for (const row of input.pos) add(row.key, row.amount, row.orders);
  if (Number(input.storeCredit?.amount ?? 0) > 0) {
    add(
      "store_credit",
      Number(input.storeCredit?.amount ?? 0),
      Number(input.storeCredit?.orders ?? 0),
    );
  }
  for (const row of input.online) add(row.key, row.amount, row.orders);
  return finalizeBreakdown(
    [...earned.values()],
    input.refunds.map((row) => ({
      ...row,
      name: paymentMethodName(row.key),
    })),
  );
}

export async function getSalesByPaymentMethod(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CommerceBreakdown[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const posRows = await db
      .select({
        key: orderPayments.method,
        amount: sql<number>`coalesce(sum(${orderPayments.amount}), 0)::float8`,
        orders: sql<number>`count(distinct ${orderPayments.orderId})::int`,
      })
      .from(orderPayments)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderPayments.orderId),
          eq(orders.storeId, storeId),
          eq(orders.salesChannel, "pos"),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(eq(orderPayments.storeId, storeId))
      .groupBy(orderPayments.method);
    const [creditRow] = await db
      .select({
        amount: sql<number>`coalesce(sum(${orders.storeCreditUsed}), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          ne(orders.salesChannel, "pos"),
          gt(orders.storeCreditUsed, 0),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      );
    const onlineRows = await db
      .select({
        key: orders.paymentMethod,
        amount: sql<number>`coalesce(sum(greatest(${orders.total} - ${orders.storeCreditUsed}, 0)), 0)::float8`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          ne(orders.salesChannel, "pos"),
          gt(sql`greatest(${orders.total} - ${orders.storeCreditUsed}, 0)`, 0),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orders.paymentMethod);
    const refundRows = await db
      .select({
        key: orderRefunds.method,
        refunds: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      )
      .groupBy(orderRefunds.method);

    return buildPaymentBreakdown({
      pos: posRows,
      online: onlineRows,
      storeCredit: creditRow ?? null,
      refunds: refundRows,
    });
  });
}

export async function getCustomerMix(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<CustomerMix> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const rows = await db
      .select({
        customerId: orders.customerId,
        firstOrderAt: sql<string>`min(${orders.createdAt})`,
        currentOrders: sql<number>`count(*) filter (where ${orders.createdAt} >= ${range.current.from.toISOString()} and ${orders.createdAt} < ${range.current.to.toISOString()})::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          isNotNull(orders.customerId),
          recognizedOrder(),
          lt(orders.createdAt, range.current.to.toISOString()),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(orders.customerId);
    return classifyCustomerMix(rows, range.current.from);
  });
}

export function classifyCustomerMix(
  rows: Array<{ firstOrderAt: string; currentOrders: number }>,
  currentFrom: Date,
): CustomerMix {
  let newCustomers = 0;
  let returningCustomers = 0;
  for (const row of rows) {
    if (Number(row.currentOrders) <= 0) continue;
    if (new Date(row.firstOrderAt) >= currentFrom) newCustomers += 1;
    else returningCustomers += 1;
  }
  return {
    newCustomers,
    returningCustomers,
    totalCustomers: newCustomers + returningCustomers,
  };
}

export async function getDiscountImpact(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<DiscountImpact> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const [orderRow] = await db
      .select({
        discounts: sql<number>`coalesce(sum(${orders.discount}), 0)::float8`,
        couponOrders: sql<number>`count(*) filter (where ${orders.appliedCouponCode} is not null)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      );
    const [lineRow] = await db
      .select({
        discounts: sql<number>`coalesce(sum(${orderItems.lineDiscount}), 0)::float8`,
      })
      .from(orderItems)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderItems.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      );
    const orderDiscounts = Number(orderRow?.discounts ?? 0);
    const lineDiscounts = Number(lineRow?.discounts ?? 0);
    return {
      orderDiscounts,
      lineDiscounts,
      totalDiscounts: orderDiscounts + lineDiscounts,
      couponOrders: Number(orderRow?.couponOrders ?? 0),
    };
  });
}

export async function getReturnsAndRefunds(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<ReturnsAndRefunds> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const [returnRow] = await db
      .select({
        count: sql<number>`count(*)::int`,
        value: sql<number>`coalesce(sum(${orderReturns.total}), 0)::float8`,
      })
      .from(orderReturns)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderReturns.orderId),
          eq(orders.storeId, storeId),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderReturns.storeId, storeId),
          eq(orderReturns.status, "completed"),
          gte(orderReturns.createdAt, range.current.from.toISOString()),
          lt(orderReturns.createdAt, range.current.to.toISOString()),
        ),
      );
    const [itemRow] = await db
      .select({
        units: sql<number>`coalesce(sum(${orderReturnItems.quantity}), 0)::int`,
      })
      .from(orderReturnItems)
      .innerJoin(
        orderReturns,
        and(
          eq(orderReturns.id, orderReturnItems.returnId),
          eq(orderReturns.storeId, storeId),
          eq(orderReturns.status, "completed"),
          gte(orderReturns.createdAt, range.current.from.toISOString()),
          lt(orderReturns.createdAt, range.current.to.toISOString()),
        ),
      )
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderReturns.orderId),
          eq(orders.storeId, storeId),
          ...(scoped ? [scoped] : []),
        ),
      );
    const [refundRow] = await db
      .select({
        value: sql<number>`coalesce(sum(${orderRefunds.amount}), 0)::float8`,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(
          eq(orders.id, orderRefunds.orderId),
          eq(orders.storeId, storeId),
          ...(scoped ? [scoped] : []),
        ),
      )
      .where(
        and(
          eq(orderRefunds.storeId, storeId),
          eq(orderRefunds.status, "completed"),
          refundWindow(range.current),
        ),
      );
    return {
      completedReturns: Number(returnRow?.count ?? 0),
      returnedUnits: Number(itemRow?.units ?? 0),
      returnedValue: Number(returnRow?.value ?? 0),
      completedRefunds: Number(refundRow?.value ?? 0),
    };
  });
}

export async function getInventoryVelocity(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<InventoryVelocityItem[]> {
  const scoped = inventoryLocationCondition(location);
  return withService(async (db) => {
    const rows = await db
      .select({
        id: stockMovements.productId,
        name: sql<string>`max(${products.name})`,
        units: sql<number>`coalesce(sum(abs(${stockMovements.delta})), 0)::int`,
      })
      .from(stockMovements)
      .innerJoin(
        products,
        and(
          eq(products.id, stockMovements.productId),
          eq(products.storeId, storeId),
        ),
      )
      .innerJoin(
        orders,
        and(
          eq(orders.id, stockMovements.orderId),
          eq(orders.storeId, storeId),
          recognizedOrder(),
        ),
      )
      .where(
        and(
          eq(stockMovements.storeId, storeId),
          eq(stockMovements.reason, "sale"),
          lt(stockMovements.delta, 0),
          gte(stockMovements.createdAt, range.current.from.toISOString()),
          lt(stockMovements.createdAt, range.current.to.toISOString()),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(stockMovements.productId)
      .orderBy(desc(sql`coalesce(sum(abs(${stockMovements.delta})), 0)`))
      .limit(10);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      units: Number(row.units),
    }));
  });
}

export async function getRecentOrders(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<RecentOrder[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const rows = await db
      .select({
        ref: orders.orderRef,
        total: orders.total,
        status: orders.status,
        createdAt: orders.createdAt,
        first: sql<string>`${orders.shippingAddress}->>'firstName'`,
        last: sql<string>`${orders.shippingAddress}->>'lastName'`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(5);
    return rows.map((row) => ({
      ref: row.ref,
      name: `${row.first ?? ""} ${row.last ?? ""}`.trim() || "Guest",
      total: Number(row.total),
      status: row.status,
      createdAt: row.createdAt,
    }));
  });
}

export async function getActivity(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
): Promise<ActivityItem[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const orderRows = await db
      .select({
        ref: orders.orderRef,
        createdAt: orders.createdAt,
        first: sql<string>`${orders.shippingAddress}->>'firstName'`,
        last: sql<string>`${orders.shippingAddress}->>'lastName'`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          orderWindow(range.current),
          ...(scoped ? [scoped] : []),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(5);
    const enquiryRows = await db
      .select({
        name: enquiries.name,
        subject: enquiries.subject,
        createdAt: enquiries.createdAt,
      })
      .from(enquiries)
      .where(
        and(
          eq(enquiries.storeId, storeId),
          gte(enquiries.createdAt, range.current.from.toISOString()),
          lt(enquiries.createdAt, range.current.to.toISOString()),
        ),
      )
      .orderBy(desc(enquiries.createdAt))
      .limit(5);
    const blogRows = await db
      .select({
        title: blogs.title,
        author: blogs.author,
        status: blogs.status,
        createdAt: blogs.createdAt,
      })
      .from(blogs)
      .where(
        and(
          eq(blogs.storeId, storeId),
          gte(blogs.createdAt, range.current.from.toISOString()),
          lt(blogs.createdAt, range.current.to.toISOString()),
        ),
      )
      .orderBy(desc(blogs.createdAt))
      .limit(5);
    return [
      ...orderRows.map((row) => ({
        kind: "order" as const,
        who: `${row.first ?? ""} ${row.last ?? ""}`.trim() || "Guest",
        detail: `placed order ${row.ref}`,
        createdAt: row.createdAt,
      })),
      ...enquiryRows.map((row) => ({
        kind: "enquiry" as const,
        who: row.name,
        detail: row.subject ? `enquired: ${row.subject}` : "sent an enquiry",
        createdAt: row.createdAt,
      })),
      ...blogRows.map((row) => ({
        kind: "blog" as const,
        who: row.author,
        detail:
          row.status === "published"
            ? `published "${row.title}"`
            : `submitted "${row.title}"`,
        createdAt: row.createdAt,
      })),
    ]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 6);
  });
}
