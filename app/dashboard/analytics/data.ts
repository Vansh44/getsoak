import "server-only";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { LocationScope } from "@/lib/locations/scope";
import { withService } from "@/lib/db/client";
import {
  blogs,
  categories,
  enquiries,
  orderItems,
  orders,
  products,
  users,
} from "@/drizzle/schema";

// Real store analytics for /dashboard/analytics. Everything is scoped by
// store_id and derived from live tables — no hardcoded figures. Empty stores
// (no orders yet) resolve to zeros/empty lists, which the components render as
// intentional empty states. Revenue counts NON-CANCELLED orders (booked
// revenue, COD + online); "this month" = current calendar month.

export interface Stat {
  value: number;
  trendPct: number; // vs previous month
  trendUp: boolean;
  spark: number[]; // trailing 12-month series (shape only)
}

export interface MonthPoint {
  label: string; // e.g. "Jun"
  revenue: number; // in thousands of rupees (chart shows "K")
  orders: number;
}

export interface TopCategory {
  name: string;
  amount: number;
  share: number; // % of item revenue
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

export interface AnalyticsData {
  stats: { revenue: Stat; orders: Stat; customers: Stat; products: Stat };
  totalRevenue: number;
  revenueSeries: { m7: MonthPoint[]; m12: MonthPoint[]; all: MonthPoint[] };
  revenueTrendPct: number;
  revenueTrendUp: boolean;
  topCategories: TopCategory[];
  recentOrders: RecentOrder[];
  activity: ActivityItem[];
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "YYYY-MM" key for a Date's month (UTC-agnostic — uses local month parts). */
function ymOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** The list of "YYYY-MM" keys for the `count` months ending at (and including) now. */
function trailingMonths(count: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    out.push(ymOf(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return out;
}

function labelForYm(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MONTH_LABELS[m - 1] ?? ym;
}

function pctChange(cur: number, prev: number): { pct: number; up: boolean } {
  if (prev <= 0) return { pct: cur > 0 ? 100 : 0, up: cur >= 0 };
  const pct = Math.round(((cur - prev) / prev) * 1000) / 10;
  return { pct, up: cur >= prev };
}

type MonthAgg = Map<string, { rev: number; ord: number }>;

/** Build MonthPoints for a set of "YYYY-MM" keys, zero-filling gaps. */
function pointsFor(yms: string[], agg: MonthAgg): MonthPoint[] {
  return yms.map((ym) => {
    const a = agg.get(ym);
    return {
      label: labelForYm(ym),
      revenue: Math.round((a?.rev ?? 0) / 1000), // thousands for the "K" chart
      orders: a?.ord ?? 0,
    };
  });
}

/** Spark helper: pull one numeric field over the trailing 12 months. */
function spark12(agg: Map<string, number>): number[] {
  return trailingMonths(12).map((ym) => agg.get(ym) ?? 0);
}

export async function getAnalyticsData(
  storeId: string,
  /**
   * ★★ SCOPED ONLY FOR A RESTRICTED VIEWER. `null` — an owner, a superadmin, an
   * admin nobody has assigned anywhere — keeps the whole-business figures, which
   * is the entire point of running several shops. A restricted admin sees only
   * their own, because otherwise the one screen they land on first would hand
   * them every other branch's revenue while the orders list refuses them a
   * single order from it.
   *
   * ⚠ ORDER-SHAPED FIGURES ONLY. Products and customers are store-wide by
   * decision (a product is not IN a shop; a customer belongs to the business),
   * so their counts stay whole even for a scoped viewer — the numbers a Delhi
   * manager sees are "Delhi's sales, the store's catalogue".
   */
  locationScope: LocationScope = null,
): Promise<AnalyticsData> {
  // Built once: `inArray(col, [])` is how "assigned to nothing that still
  // exists" is expressed, so an EMPTY scope must match nothing rather than be
  // skipped.
  const scoped =
    locationScope === null ? null : inArray(orders.locationId, locationScope);

  return withService(async (db) => {
    const thisYm = ymOf(new Date());
    const prevYm = ymOf(
      new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
    );

    // --- monthly order revenue + count (non-cancelled), all history ---
    const orderMonthRows = await db
      .select({
        ym: sql<string>`to_char(date_trunc('month', ${orders.createdAt}), 'YYYY-MM')`,
        rev: sql<number>`coalesce(sum(${orders.total}), 0)::float8`,
        ord: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          ne(orders.status, "cancelled"),
          ...(scoped ? [scoped] : []),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const orderAgg: MonthAgg = new Map();
    for (const r of orderMonthRows)
      orderAgg.set(r.ym, { rev: Number(r.rev), ord: Number(r.ord) });

    // --- new customers + new products per month (for trend + sparkline) ---
    const [custMonthRows, prodMonthRows] = await Promise.all([
      db
        .select({
          ym: sql<string>`to_char(date_trunc('month', ${users.createdAt}), 'YYYY-MM')`,
          n: sql<number>`count(*)::int`,
        })
        .from(users)
        .where(eq(users.storeId, storeId))
        .groupBy(sql`1`),
      db
        .select({
          ym: sql<string>`to_char(date_trunc('month', ${products.createdAt}), 'YYYY-MM')`,
          n: sql<number>`count(*)::int`,
        })
        .from(products)
        .where(eq(products.storeId, storeId))
        .groupBy(sql`1`),
    ]);
    const custAgg = new Map<string, number>(
      custMonthRows.map((r) => [r.ym, Number(r.n)]),
    );
    const prodAgg = new Map<string, number>(
      prodMonthRows.map((r) => [r.ym, Number(r.n)]),
    );

    // --- scalar totals ---
    const [[{ c: totalCustomers }], [{ c: productsPublished }]] =
      await Promise.all([
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(users)
          .where(eq(users.storeId, storeId)),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(products)
          .where(
            and(
              eq(products.storeId, storeId),
              eq(products.status, "published"),
            ),
          ),
      ]);

    const totalRevenue = orderMonthRows.reduce((s, r) => s + Number(r.rev), 0);

    // --- trends (current vs previous calendar month) ---
    const revThis = orderAgg.get(thisYm)?.rev ?? 0;
    const revPrev = orderAgg.get(prevYm)?.rev ?? 0;
    const ordThis = orderAgg.get(thisYm)?.ord ?? 0;
    const ordPrev = orderAgg.get(prevYm)?.ord ?? 0;
    const custThis = custAgg.get(thisYm) ?? 0;
    const custPrev = custAgg.get(prevYm) ?? 0;
    const prodThis = prodAgg.get(thisYm) ?? 0;
    const prodPrev = prodAgg.get(prevYm) ?? 0;

    const revTrend = pctChange(revThis, revPrev);
    const ordTrend = pctChange(ordThis, ordPrev);
    const custTrend = pctChange(custThis, custPrev);
    const prodTrend = pctChange(prodThis, prodPrev);

    // --- sparklines (trailing 12 months) ---
    const revSpark = trailingMonths(12).map((ym) =>
      Math.round((orderAgg.get(ym)?.rev ?? 0) / 1000),
    );
    const ordSpark = trailingMonths(12).map((ym) => orderAgg.get(ym)?.ord ?? 0);

    // --- revenue chart series (7M / 12M / all history) ---
    const firstYm = orderMonthRows[0]?.ym;
    const allYms = firstYm
      ? monthsBetween(firstYm, thisYm)
      : trailingMonths(12);
    const revenueSeries = {
      m7: pointsFor(trailingMonths(7), orderAgg),
      m12: pointsFor(trailingMonths(12), orderAgg),
      all: pointsFor(allYms, orderAgg),
    };

    // --- revenue by category ---
    // EVERY category the store has is reported, not just the sellers: two
    // queries (earners + the full category list) merged below, so a category
    // with no sales yet shows as ₹0 instead of silently vanishing. "Uncategorized"
    // is appended only when products without a category actually earned.
    const [catRows, allCatRows] = await Promise.all([
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
            ...(scoped ? [scoped] : []),
            ne(orders.status, "cancelled"),
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

    const earned = new Map<string, number>(
      catRows.map((r) => [r.name, Number(r.amount)]),
    );
    const catTotal = catRows.reduce((s, r) => s + Number(r.amount), 0);
    const catNames = allCatRows.map((r) => r.name).filter(Boolean) as string[];
    if ((earned.get("Uncategorized") ?? 0) > 0) catNames.push("Uncategorized");

    const topCategories: TopCategory[] = catNames
      .map((name) => ({ name, amount: earned.get(name) ?? 0 }))
      // Earners first (biggest down), then the rest alphabetically.
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
      .map((r) => ({
        name: r.name,
        amount: Number(r.amount),
        share:
          catTotal > 0 ? Math.round((Number(r.amount) / catTotal) * 100) : 0,
      }));

    // --- recent orders ---
    const recentRows = await db
      .select({
        ref: orders.orderRef,
        total: orders.total,
        status: orders.status,
        createdAt: orders.createdAt,
        first: sql<string>`${orders.shippingAddress}->>'firstName'`,
        last: sql<string>`${orders.shippingAddress}->>'lastName'`,
      })
      .from(orders)
      .where(and(eq(orders.storeId, storeId), ...(scoped ? [scoped] : [])))
      .orderBy(desc(orders.createdAt))
      .limit(5);
    const recentOrders: RecentOrder[] = recentRows.map((r) => ({
      ref: r.ref,
      name: `${r.first ?? ""} ${r.last ?? ""}`.trim() || "Guest",
      total: Number(r.total),
      status: r.status,
      createdAt: r.createdAt,
    }));

    // --- activity feed (recent orders + enquiries + blog submissions) ---
    const [enqRows, blogRows] = await Promise.all([
      db
        .select({
          name: enquiries.name,
          subject: enquiries.subject,
          createdAt: enquiries.createdAt,
        })
        .from(enquiries)
        .where(eq(enquiries.storeId, storeId))
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
        .where(eq(blogs.storeId, storeId))
        .orderBy(desc(blogs.createdAt))
        .limit(5),
    ]);
    const activity: ActivityItem[] = [
      ...recentOrders.map((o) => ({
        kind: "order" as const,
        who: o.name,
        detail: `placed order ${o.ref}`,
        createdAt: o.createdAt,
      })),
      ...enqRows.map((e) => ({
        kind: "enquiry" as const,
        who: e.name,
        detail: e.subject ? `enquired: ${e.subject}` : "sent an enquiry",
        createdAt: e.createdAt,
      })),
      ...blogRows.map((b) => ({
        kind: "blog" as const,
        who: b.author,
        detail:
          b.status === "published"
            ? `published "${b.title}"`
            : `submitted "${b.title}"`,
        createdAt: b.createdAt,
      })),
    ]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 6);

    return {
      stats: {
        revenue: {
          value: totalRevenue,
          trendPct: revTrend.pct,
          trendUp: revTrend.up,
          spark: revSpark,
        },
        orders: {
          value: ordThis,
          trendPct: ordTrend.pct,
          trendUp: ordTrend.up,
          spark: ordSpark,
        },
        customers: {
          value: totalCustomers,
          trendPct: custTrend.pct,
          trendUp: custTrend.up,
          spark: spark12(custAgg),
        },
        products: {
          value: productsPublished,
          trendPct: prodTrend.pct,
          trendUp: prodTrend.up,
          spark: spark12(prodAgg),
        },
      },
      totalRevenue,
      revenueSeries,
      revenueTrendPct: revTrend.pct,
      revenueTrendUp: revTrend.up,
      topCategories,
      recentOrders,
      activity,
    };
  });
}

/** Inclusive list of "YYYY-MM" keys from `startYm` to `endYm`. */
function monthsBetween(startYm: string, endYm: string): string[] {
  const out: string[] = [];
  let y = Number(startYm.slice(0, 4));
  let m = Number(startYm.slice(5, 7));
  const ey = Number(endYm.slice(0, 4));
  const em = Number(endYm.slice(5, 7));
  // Safety cap so a very old first order can't explode the array.
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 120) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
