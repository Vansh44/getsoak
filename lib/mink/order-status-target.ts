import "server-only";

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { orders, storeLocations } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
import { MinkRequestError, MinkToolInputError } from "./errors";
import type { MinkActorContext } from "./types";

export interface MinkOrderStatusTargetRecord {
  id: string;
  reference: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  salesChannel: string;
  fulfilmentType: string;
  cancellationStatus: string | null;
  locationId: string | null;
  locationName: string | null;
  customerId: string | null;
  shipmentStatus: string | null;
  updatedAt: string;
}

export async function readMinkOrderStatusTarget(
  db: Db,
  actor: MinkActorContext,
  selector: { orderId?: string; orderRef?: string },
): Promise<MinkOrderStatusTargetRecord> {
  if (!selector.orderId && !selector.orderRef) throw targetNotFound();
  const locationCondition =
    actor.locationIds === null
      ? undefined
      : actor.locationIds.length
        ? inArray(orders.locationId, actor.locationIds)
        : sql`false`;
  const rows = await db
    .select({
      id: orders.id,
      reference: orders.orderRef,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      salesChannel: orders.salesChannel,
      fulfilmentType: orders.fulfilmentType,
      cancellationStatus: orders.cancellationStatus,
      locationId: orders.locationId,
      locationName: storeLocations.name,
      customerId: orders.customerId,
      updatedAt: orders.updatedAt,
      shipmentStatus: sql<string | null>`(
        select shipment.status
        from public.shipments shipment
        where shipment.store_id = ${actor.storeId}::uuid
          and shipment.order_id = ${orders.id}
        order by shipment.created_at desc, shipment.id desc
        limit 1
      )`,
    })
    .from(orders)
    .leftJoin(
      storeLocations,
      and(
        eq(storeLocations.id, orders.locationId),
        eq(storeLocations.storeId, actor.storeId),
      ),
    )
    .where(
      and(
        eq(orders.storeId, actor.storeId),
        selector.orderId ? eq(orders.id, selector.orderId) : undefined,
        selector.orderRef ? eq(orders.orderRef, selector.orderRef) : undefined,
        locationCondition,
      ),
    )
    .limit(2);
  if (rows.length !== 1) throw targetNotFound();
  return rows[0];
}

export function minkOrderStatusSnapshot(
  actor: MinkActorContext,
  order: MinkOrderStatusTargetRecord,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        actor.storeId,
        actor.adminId,
        order.id,
        order.reference,
        order.status,
        order.paymentMethod,
        order.paymentStatus,
        order.salesChannel,
        order.fulfilmentType,
        order.cancellationStatus,
        order.locationId,
        order.shipmentStatus,
        order.updatedAt,
      ]),
    )
    .digest("hex");
}

export function normalizeMinkOrderReference(value: unknown): string {
  if (typeof value !== "string") {
    throw new MinkToolInputError(
      "order_ref must be visible order-reference text.",
    );
  }
  const reference = value.normalize("NFKC").trim();
  if (!reference || reference.length > 80) {
    throw new MinkToolInputError(
      "order_ref must be between 1 and 80 characters.",
    );
  }
  return reference;
}

function targetNotFound() {
  return new MinkRequestError(
    "mink_order_target_not_found",
    "That exact order is not available in your current store and location access.",
    404,
  );
}
