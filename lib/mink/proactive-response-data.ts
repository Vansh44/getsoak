import "server-only";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { orders, orderReturns } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { locationCondition } from "@/app/dashboard/analytics/data";
import { collectBusinessBriefSnapshot } from "./business-brief-data";
import {
  buildBusinessBriefResult,
  businessBriefRange,
} from "./business-brief-types";
import { readMinkCatalogHealth } from "./catalog-health-read";
import type { WorkflowExecutionScope } from "./workflow-template-data";
import type {
  ProactiveResponseInput,
  ProactiveResponseResult,
} from "./proactive-response-types";

/** Fresh evidence first. Source errors propagate to the durable worker's retry policy. */
export async function collectProactiveResponse(
  storeId: string,
  adminId: string,
  input: ProactiveResponseInput,
  scope: WorkflowExecutionScope,
): Promise<ProactiveResponseResult> {
  const fresh = buildBusinessBriefResult(
    await collectBusinessBriefSnapshot(
      storeId,
      { uid: adminId, email: input.requesterEmail },
      input,
      scope,
    ),
  );
  const evidence = fresh.signals.find((s) => s.key === input.signal)!;
  const result: ProactiveResponseResult = {
    signal: input.signal,
    evidence,
    dataAsOf: fresh.dataAsOf,
    locationLabel: fresh.locationLabel,
    timeZone: fresh.timeZone,
    rangeLabel: fresh.rangeLabel,
    rows: [],
    truncated: false,
    nextSteps: [evidence.nextStep],
    limitations: [
      ...fresh.limitations.slice(0, -1),
      "This approved investigation is read-only. Never treat a suggested action as executed or as permission to change business records.",
      "At most 20 detail rows; inventory detail covers at most 3 affected locations. Missing rows in a limited list are not proof of healthy stock.",
    ],
  };
  if (evidence.status !== "attention") {
    result.nextSteps = [
      evidence.status === "insufficient_data"
        ? "There is not enough current evidence to recommend a remedy. Review the source records."
        : "The original signal did not trigger on recheck. No remedy was applied.",
    ];
    return result;
  }
  if (input.signal === "inventory") {
    const affected = fresh.locations
      .filter((l) => l.lowStock + l.outOfStock > 0)
      .sort(
        (a, b) =>
          b.outOfStock - a.outOfStock ||
          b.lowStock - a.lowStock ||
          a.id.localeCompare(b.id),
      );
    result.truncated = affected.length > 3;
    for (const location of affected.slice(0, 3)) {
      const health = await readMinkCatalogHealth({
        storeId,
        identity: { uid: adminId, email: input.requesterEmail },
        locationIds: [location.id],
        defaultThreshold: input.defaultLowStockThreshold,
        includeInventory: true,
        limit: 21,
      });
      const items = health.items.filter(
        (i) => i.inventoryStatus === "out" || i.inventoryStatus === "low",
      );
      for (const item of items) {
        if (result.rows.length === 20) {
          result.truncated = true;
          break;
        }
        result.rows.push({
          label: `${item.productName}${item.variantName ? ` · ${item.variantName}` : ""}`,
          detail: `${location.name} · ${item.sku} · Stock ${item.stock} · Threshold ${item.threshold} · ${item.inventoryStatus === "out" ? "Out of stock" : "Low stock"}`,
          path: `/dashboard/inventory?location=${encodeURIComponent(location.id)}`,
        });
      }
      result.truncated ||= health.truncated;
    }
    result.nextSteps = [
      "Count the shelf at the named location and reconcile any discrepancy first.",
      "Review transfer or replenishment options for the listed SKUs. Do not assume a transfer quantity or create stock from a sales estimate.",
      "If a stock correction is needed, request an exact SKU, location and counted quantity in Mink chat, then review its separate inventory proposal.",
    ];
  } else if (input.signal === "payments" || input.signal === "returns") {
    const range = businessBriefRange(input);
    const location = {
      locationIds: scope.locationIds,
      selectedId: null,
      includeUnassigned: input.includeUnassigned,
    };
    const rows = await withService(async (db) =>
      input.signal === "payments"
        ? db
            .select({ id: orders.id, status: orders.paymentStatus })
            .from(orders)
            .where(
              and(
                eq(orders.storeId, storeId),
                locationCondition(location),
                eq(orders.paymentStatus, "failed"),
                gte(orders.createdAt, range.current.from.toISOString()),
                lt(orders.createdAt, range.current.to.toISOString()),
              ),
            )
            .orderBy(asc(orders.createdAt), asc(orders.id))
            .limit(21)
        : db
            .select({ id: orderReturns.id, status: orderReturns.status })
            .from(orderReturns)
            .innerJoin(
              orders,
              and(
                eq(orders.id, orderReturns.orderId),
                eq(orders.storeId, storeId),
              ),
            )
            .where(
              and(
                eq(orderReturns.storeId, storeId),
                locationCondition(location),
                sql`${orderReturns.status} not in ('rejected','cancelled')`,
                gte(orderReturns.createdAt, range.current.from.toISOString()),
                lt(orderReturns.createdAt, range.current.to.toISOString()),
              ),
            )
            .orderBy(asc(orderReturns.createdAt), asc(orderReturns.id))
            .limit(21),
    );
    result.truncated = rows.length > 20;
    result.rows = rows.slice(0, 20).map((row) => ({
      label: `${input.signal === "payments" ? "Order" : "Return"} ${row.id}`,
      detail: `Current status: ${row.status}`,
      path:
        input.signal === "payments"
          ? `/dashboard/orders/${encodeURIComponent(row.id)}`
          : "/dashboard/orders/returns",
    }));
    result.nextSteps =
      input.signal === "payments"
        ? [
            "Review each order and its provider/payment history before deciding whether to retry or contact the customer.",
            "No payment was retried and no customer was contacted. Payment-provider changes and refunds are outside this approval.",
          ]
        : [
            "Review the listed return records and their reasons; an increase in record counts does not establish a product defect or return rate.",
            "Use the normal return/refund workflow for any remedy. This review approves no refund, cancellation or customer message.",
          ];
  } else {
    result.rows = [
      {
        label: "Recognized net sales",
        detail: `${fresh.currency} ${fresh.netSales} versus ${fresh.previousNetSales} previously`,
        path: "/dashboard/analytics",
      },
      {
        label: "Recognized orders",
        detail: `${fresh.orders} versus ${fresh.previousOrders} previously`,
        path: "/dashboard/analytics",
      },
    ];
    result.nextSteps = [
      "Review channel, product and location movements in Analytics; the sales difference does not establish a cause.",
      "Ask Mink to investigate the sales decline over 7, 30 or 90 days for a deeper breakdown. Any promotional or pricing change needs its own scoped proposal and approval.",
    ];
  }
  return result;
}
