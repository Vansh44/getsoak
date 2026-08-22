import "server-only";

import { and, eq, gte, lte } from "drizzle-orm";
import { storefrontDaily } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import type { AnalyticsRange } from "@/lib/analytics/range";
import type { Stat } from "./data";

export interface StorefrontAnalytics {
  visitors: Stat;
  sessions: Stat;
  pageViews: Stat;
  productSessions: number;
  cartSessions: number;
  checkoutSessions: number;
  convertedSessions: number;
  purchases: number;
  conversionRate: number;
}

function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function stat(value: number, spark: number[]): Stat {
  return { value, spark, trendPct: null, trendUp: true };
}

export async function storeHasProAnalytics(storeId: string): Promise<boolean> {
  return storeHasAnalyticsFeature(storeId, "storefrontConversion");
}

export async function getStorefrontAnalytics(
  storeId: string,
  range: AnalyticsRange,
): Promise<StorefrontAnalytics> {
  const from = dateKey(range.current.from, range.timeZone);
  const to = dateKey(new Date(range.current.to.getTime() - 1), range.timeZone);
  const rows = await withService((db) =>
    db
      .select({
        date: storefrontDaily.date,
        visitors: storefrontDaily.visitors,
        sessions: storefrontDaily.sessions,
        pageViews: storefrontDaily.pageViews,
        productSessions: storefrontDaily.productSessions,
        cartSessions: storefrontDaily.cartSessions,
        checkoutSessions: storefrontDaily.checkoutSessions,
        convertedSessions: storefrontDaily.convertedSessions,
        purchases: storefrontDaily.purchases,
      })
      .from(storefrontDaily)
      .where(
        and(
          eq(storefrontDaily.storeId, storeId),
          gte(storefrontDaily.date, from),
          lte(storefrontDaily.date, to),
        ),
      )
      .orderBy(storefrontDaily.date),
  );
  const sum = (key: keyof (typeof rows)[number]) =>
    rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const sessions = sum("sessions");
  const convertedSessions = sum("convertedSessions");
  return {
    visitors: stat(
      sum("visitors"),
      rows.map((row) => row.visitors),
    ),
    sessions: stat(
      sessions,
      rows.map((row) => row.sessions),
    ),
    pageViews: stat(
      sum("pageViews"),
      rows.map((row) => row.pageViews),
    ),
    productSessions: sum("productSessions"),
    cartSessions: sum("cartSessions"),
    checkoutSessions: sum("checkoutSessions"),
    convertedSessions,
    purchases: sum("purchases"),
    conversionRate: sessions > 0 ? (convertedSessions / sessions) * 100 : 0,
  };
}
