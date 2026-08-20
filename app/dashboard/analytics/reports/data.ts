import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { orderRefunds, orders, storeLocations } from "@/drizzle/schema";
import type { AnalyticsLocationSelection } from "@/lib/analytics/location";
import type { AnalyticsRange } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import {
  locationCondition,
  orderWindow,
  recognizedOrder,
  refundWindow,
} from "../data";

export interface TotalSalesReportRow {
  id: string;
  occurredAt: string;
  event: "Sale" | "Refund";
  orderRef: string;
  channel: string;
  location: string;
  amount: number;
}

function channelLabel(value: string): string {
  if (value === "pos") return "Point of sale";
  if (value === "online") return "Online store";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/** A ledger-shaped explanation of the headline sales number. Sales use order
 * creation time; negative refund events use settlement time, matching the card. */
export async function getTotalSalesReport(
  storeId: string,
  location: AnalyticsLocationSelection,
  range: AnalyticsRange,
  limit: number,
): Promise<TotalSalesReportRow[]> {
  const scoped = locationCondition(location);
  return withService(async (db) => {
    const saleRows = await db
      .select({
        id: orders.id,
        occurredAt: orders.createdAt,
        orderRef: orders.orderRef,
        channel: orders.salesChannel,
        location: sql<string>`coalesce(${storeLocations.name}, 'Online / unassigned')`,
        amount: orders.total,
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
      .orderBy(desc(orders.createdAt))
      .limit(limit);
    const refundRows = await db
      .select({
        id: orderRefunds.id,
        occurredAt: orderRefunds.createdAt,
        orderRef: orders.orderRef,
        channel: orders.salesChannel,
        location: sql<string>`coalesce(${storeLocations.name}, 'Online / unassigned')`,
        amount: orderRefunds.amount,
      })
      .from(orderRefunds)
      .innerJoin(
        orders,
        and(eq(orders.id, orderRefunds.orderId), eq(orders.storeId, storeId)),
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
          ...(scoped ? [scoped] : []),
        ),
      )
      .orderBy(desc(orderRefunds.createdAt))
      .limit(limit);

    return [
      ...saleRows.map((row) => ({
        ...row,
        event: "Sale" as const,
        channel: channelLabel(row.channel),
        amount: Number(row.amount),
      })),
      ...refundRows.map((row) => ({
        ...row,
        event: "Refund" as const,
        channel: channelLabel(row.channel),
        amount: -Number(row.amount),
      })),
    ]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit);
  });
}
