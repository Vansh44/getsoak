import "server-only";

import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  fulfilmentOrders,
  orders,
  shipmentEvents,
  shipments,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { emitEvent } from "@/lib/notifications/record";
import {
  acceptShipmentTransition,
  mapShiprocketStatus,
  type ShipmentStatus,
} from "./status";

type Obj = Record<string, unknown>;

export interface CarrierTrackingUpdate {
  status: ShipmentStatus;
  externalStatus: string;
  externalCode: string | null;
  description: string | null;
  location: string | null;
  occurredAt: string;
  awb: string | null;
  externalShipmentId: string | null;
  payload: Obj;
}

function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

function value(...values: unknown[]): string {
  const found = values.find(
    (item) =>
      (typeof item === "string" && item.trim()) || typeof item === "number",
  );
  return found == null ? "" : String(found).trim();
}

function dateValue(input: unknown): string {
  const date = new Date(value(input));
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

/** Normalize both Shiprocket webhook and AWB tracking response shapes. */
export function parseShiprocketTracking(raw: unknown): CarrierTrackingUpdate[] {
  const root = object(raw);
  const payload = object(root.payload);
  const trackingData = object(root.tracking_data ?? payload.tracking_data);
  const tracks = Array.isArray(trackingData.shipment_track)
    ? trackingData.shipment_track.map(object)
    : [];
  const track =
    tracks[0] ?? object(root.shipment_track ?? payload.shipment_track);
  const awb = value(
    root.awb,
    root.awb_code,
    payload.awb,
    payload.awb_code,
    track.awb_code,
  );
  const externalShipmentId = value(
    root.shipment_id,
    payload.shipment_id,
    track.shipment_id,
  );
  const activitiesRaw =
    trackingData.shipment_track_activities ??
    root.shipment_track_activities ??
    payload.shipment_track_activities;
  const activities = Array.isArray(activitiesRaw)
    ? activitiesRaw.slice(-200).map(object)
    : [];

  const updates = activities.map((activity) => {
    const code = value(
      activity["sr-status"],
      activity.sr_status,
      activity.status_code,
      activity.shipment_status_id,
    );
    const label = value(
      activity["sr-status-label"],
      activity.status,
      activity.activity,
    );
    return {
      status: mapShiprocketStatus(code, label),
      externalStatus: label,
      externalCode: code || null,
      description: value(activity.activity, activity.status) || null,
      location: value(activity.location) || null,
      occurredAt: dateValue(
        activity.date ?? activity.activity_date ?? activity.updated_at,
      ),
      awb: awb || null,
      externalShipmentId: externalShipmentId || null,
      payload: activity,
    } satisfies CarrierTrackingUpdate;
  });

  if (updates.length > 0) {
    return updates.sort(
      (a, b) =>
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    );
  }

  const code = value(
    root.current_status_id,
    root.shipment_status_id,
    root.status_code,
    payload.current_status_id,
    payload.shipment_status_id,
    track.current_status_id,
  );
  const label = value(
    root.current_status,
    root.shipment_status,
    root.status,
    payload.current_status,
    payload.shipment_status,
    track.current_status,
  );
  if (!code && !label) return [];
  return [
    {
      status: mapShiprocketStatus(code, label),
      externalStatus: label,
      externalCode: code || null,
      description: value(root.activity, root.status_description, label) || null,
      location:
        value(root.location, root.current_location, payload.location) || null,
      occurredAt: dateValue(
        root.current_timestamp ?? root.updated_at ?? payload.updated_at,
      ),
      awb: awb || null,
      externalShipmentId: externalShipmentId || null,
      payload: root,
    },
  ];
}

function eventHash(shipmentId: string, event: CarrierTrackingUpdate): string {
  return createHash("sha256")
    .update(
      [
        shipmentId,
        event.externalCode,
        event.externalStatus,
        event.description,
        event.location,
        JSON.stringify(event.payload),
      ].join("|"),
    )
    .digest("hex");
}

export async function recordShipmentTrackingUpdate(
  shipmentId: string,
  update: CarrierTrackingUpdate,
): Promise<{ accepted: boolean; status?: ShipmentStatus }> {
  const rows = await withService((db) =>
    db
      .select({
        id: shipments.id,
        storeId: shipments.storeId,
        orderId: shipments.orderId,
        fulfilmentOrderId: shipments.fulfilmentOrderId,
        status: shipments.status,
      })
      .from(shipments)
      .where(eq(shipments.id, shipmentId))
      .limit(1),
  );
  const shipment = rows[0];
  if (!shipment) return { accepted: false };

  const inserted = await withService((db) =>
    db
      .insert(shipmentEvents)
      .values({
        shipmentId,
        storeId: shipment.storeId,
        eventHash: eventHash(shipmentId, update),
        status: update.status,
        externalStatus: update.externalStatus || null,
        externalCode: update.externalCode,
        description: update.description,
        location: update.location,
        occurredAt: update.occurredAt,
        payload: update.payload,
      })
      .onConflictDoNothing()
      .returning({ id: shipmentEvents.id }),
  );
  if (!inserted.length)
    return { accepted: false, status: shipment.status as ShipmentStatus };

  const next = acceptShipmentTransition(
    shipment.status as ShipmentStatus,
    update.status,
  );
  const now = new Date().toISOString();
  const timestamps: Record<string, string> = {};
  if (next === "picked_up") timestamps.pickedUpAt = update.occurredAt;
  if (next === "delivered") timestamps.deliveredAt = update.occurredAt;
  await withService((db) =>
    db
      .update(shipments)
      .set({
        status: next,
        lastError: null,
        updatedAt: now,
        ...timestamps,
      })
      .where(eq(shipments.id, shipmentId)),
  );

  if (
    [
      "picked_up",
      "in_transit",
      "out_for_delivery",
      "ndr",
      "rto_initiated",
      "rto_in_transit",
      "rto_delivered",
      "lost",
      "damaged",
    ].includes(next)
  ) {
    await setOrderJourney(shipment.orderId, shipment.storeId, "shipped", null);
    await withService((db) =>
      db
        .update(fulfilmentOrders)
        .set({
          status: "fulfilled",
          fulfilledAt: update.occurredAt,
          updatedAt: now,
        })
        .where(eq(fulfilmentOrders.id, shipment.fulfilmentOrderId)),
    );
  } else if (next === "delivered") {
    await setOrderJourney(
      shipment.orderId,
      shipment.storeId,
      "delivered",
      update.occurredAt,
    );
    await withService((db) =>
      db
        .update(fulfilmentOrders)
        .set({
          status: "fulfilled",
          fulfilledAt: update.occurredAt,
          updatedAt: now,
        })
        .where(eq(fulfilmentOrders.id, shipment.fulfilmentOrderId)),
    );
  }

  return { accepted: true, status: next };
}

async function setOrderJourney(
  orderId: string,
  storeId: string,
  status: "shipped" | "delivered",
  deliveredAt: string | null,
) {
  const rows = await withService((db) =>
    db
      .update(orders)
      .set({
        status,
        updatedAt: new Date().toISOString(),
        ...(deliveredAt ? { deliveredAt } : {}),
      })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.storeId, storeId),
          // Carrier callbacks may not revive a merchant-cancelled order.
          // The shipment event remains available for audit.
          inArray(
            orders.status,
            status === "delivered"
              ? ["pending", "confirmed", "processing", "shipped"]
              : ["pending", "confirmed", "processing"],
          ),
        ),
      )
      .returning({
        orderRef: orders.orderRef,
        customerId: orders.customerId,
      }),
  );
  const row = rows[0];
  if (!row) return;
  emitEvent({
    type: "order.status_changed",
    storeId,
    actor: { type: "system", label: "Shiprocket" },
    subject: { type: "order", id: orderId, label: row.orderRef },
    customerId: row.customerId,
    payload: { status },
  });
}
