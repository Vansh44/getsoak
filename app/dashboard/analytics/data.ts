import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  inArray,
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
  orderRefunds,
  orders,
  products,
  users,
} from "@/drizzle/schema";
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
}

export interface SalesAnalytics {
  totalSales: Stat;
  orders: Stat;
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

function locationCondition(scope: LocationScope): SQL | undefined {
  if (scope === null) return undefined;
  // Online/unrouted orders have no physical location and remain visible to
  // every scoped viewer, matching lib/locations/scope.ts's security contract.
  return or(isNull(orders.locationId), inArray(orders.locationId, scope));
}

/** The single recognized-sale contract shared by all Phase 1 commerce cards. */
function recognizedOrder(): SQL {
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

function orderWindow(window: AnalyticsWindow): SQL {
  return and(
    gte(orders.createdAt, window.from.toISOString()),
    lt(orders.createdAt, window.to.toISOString()),
  ) as SQL;
}

function refundWindow(window: AnalyticsWindow): SQL {
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
  scope: LocationScope,
  range: AnalyticsRange,
): Promise<SalesAnalytics> {
  const scoped = locationCondition(scope);
  const grain = grainFor(range.current);

  return withService(async (db) => {
    const totalsFor = async (window: AnalyticsWindow) => {
      const [[orderRow], [refundRow]] = await Promise.all([
        db
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
          ),
        db
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
          ),
      ]);
      return {
        sales: Number(orderRow?.sales ?? 0) - Number(refundRow?.refunds ?? 0),
        orders: Number(orderRow?.count ?? 0),
      };
    };

    const bucket = sql`date_trunc(${grain}, ${orders.createdAt} at time zone ${range.timeZone})`;
    const refundBucket = sql`date_trunc(${grain}, ${orderRefunds.createdAt} at time zone ${range.timeZone})`;
    const [current, previous, orderRows, refundRows] = await Promise.all([
      totalsFor(range.current),
      range.compare ? totalsFor(range.compare) : Promise.resolve(null),
      db
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
        .groupBy(bucket)
        .orderBy(bucket),
      db
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
        .groupBy(refundBucket)
        .orderBy(refundBucket),
    ]);

    const points = new Map<string, { sales: number; orders: number }>();
    for (const row of orderRows) {
      points.set(row.key, {
        sales: Number(row.sales),
        orders: Number(row.count),
      });
    }
    for (const row of refundRows) {
      const point = points.get(row.key) ?? { sales: 0, orders: 0 };
      point.sales -= Number(row.refunds);
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
    const [[customers], [published]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.storeId, storeId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(
          and(eq(products.storeId, storeId), eq(products.status, "published")),
        ),
    ]);
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
  scope: LocationScope,
  range: AnalyticsRange,
): Promise<TopCategory[]> {
  const scoped = locationCondition(scope);
  return withService(async (db) => {
    const [earnedRows, categoryRows] = await Promise.all([
      db
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
        .orderBy(desc(sql`coalesce(sum(${orderItems.total}), 0)`)),
      db
        .select({ name: categories.name })
        .from(categories)
        .where(eq(categories.storeId, storeId)),
    ]);
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

export async function getRecentOrders(
  storeId: string,
  scope: LocationScope,
  range: AnalyticsRange,
): Promise<RecentOrder[]> {
  const scoped = locationCondition(scope);
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
  scope: LocationScope,
  range: AnalyticsRange,
): Promise<ActivityItem[]> {
  const scoped = locationCondition(scope);
  return withService(async (db) => {
    const [orderRows, enquiryRows, blogRows] = await Promise.all([
      db
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
        .limit(5),
      db
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
        .limit(5),
      db
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
        .limit(5),
    ]);
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
