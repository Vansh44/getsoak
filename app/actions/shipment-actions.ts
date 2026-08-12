"use server";

import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  fulfilmentOrders,
  locationLogisticsMappings,
  orderItems,
  orders,
  shipmentEvents,
  shipmentItems,
  shipments,
  storeLocations,
  storeLogisticsProviders,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import {
  ensureFulfilmentOrder,
  markFulfilmentInProgress,
} from "@/lib/logistics/fulfilment";
import { getShiprocketSessionForStore } from "@/lib/logistics/connection";
import {
  actOnShiprocketNdr,
  assignShiprocketAwb,
  cancelShiprocketAwb,
  createShiprocketOrder,
  generateShiprocketLabel,
  generateShiprocketManifest,
  scheduleShiprocketPickup,
  trackShiprocketAwb,
} from "@/lib/logistics/shiprocket";
import {
  parseShiprocketTracking,
  recordShipmentTrackingUpdate,
} from "@/lib/logistics/tracking";
import {
  shipmentStatusLabel,
  type ShipmentStatus,
} from "@/lib/logistics/status";

export interface ParcelInput {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  courierId?: string;
}

export interface ShipmentView {
  id: string;
  provider: string;
  status: ShipmentStatus;
  statusLabel: string;
  awb: string | null;
  courierName: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  manifestUrl: string | null;
  lastError: string | null;
  ndrReason: string | null;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  createdAt: string;
  events: Array<{
    id: string;
    status: string;
    description: string | null;
    location: string | null;
    occurredAt: string;
  }>;
}

export interface OrderLogisticsView {
  connected: boolean;
  mapped: boolean;
  locationName: string | null;
  defaults: ParcelInput;
  shipments: ShipmentView[];
}

type ActionResult = {
  success?: boolean;
  error?: string;
  shipment?: ShipmentView;
};

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return Math.round(value * 100) / 100;
}

function field(address: Record<string, unknown>, key: string): string {
  const value = address[key];
  return typeof value === "string" ? value.trim() : "";
}

async function orderForShipment(storeId: string, orderId: string) {
  const [orderRows, lines] = await Promise.all([
    withService((db) =>
      db
        .select({
          id: orders.id,
          orderRef: orders.orderRef,
          createdAt: orders.createdAt,
          status: orders.status,
          fulfilmentType: orders.fulfilmentType,
          locationId: orders.locationId,
          paymentMethod: orders.paymentMethod,
          shippingAddress: orders.shippingAddress,
          subtotal: orders.subtotal,
          shipping: orders.shipping,
          discount: orders.discount,
          total: orders.total,
          storeCreditUsed: orders.storeCreditUsed,
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
        .limit(1),
    ),
    withService((db) =>
      db
        .select({
          id: orderItems.id,
          name: orderItems.name,
          sku: orderItems.sku,
          hsn: orderItems.hsnCode,
          quantity: orderItems.quantity,
          price: orderItems.price,
          total: orderItems.total,
          taxRate: orderItems.taxRate,
          requiresShipping: orderItems.requiresShipping,
          weightGrams: orderItems.weightGrams,
          lengthCm: orderItems.lengthCm,
          widthCm: orderItems.widthCm,
          heightCm: orderItems.heightCm,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId)),
    ),
  ]);
  return { order: orderRows[0], lines };
}

function parcelDefaults(
  lines: Awaited<ReturnType<typeof orderForShipment>>["lines"],
): ParcelInput {
  const physical = lines.filter((line) => line.requiresShipping);
  return {
    weightGrams: Math.max(
      500,
      physical.reduce(
        (total, line) => total + (line.weightGrams ?? 0) * line.quantity,
        0,
      ),
    ),
    lengthCm: Math.max(10, ...physical.map((line) => line.lengthCm ?? 0)),
    widthCm: Math.max(10, ...physical.map((line) => line.widthCm ?? 0)),
    heightCm: Math.max(
      5,
      physical.reduce(
        (total, line) => total + (line.heightCm ?? 0) * line.quantity,
        0,
      ),
    ),
  };
}

async function shipmentView(
  shipmentId: string,
): Promise<ShipmentView | undefined> {
  const [rows, events] = await Promise.all([
    withService((db) =>
      db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1),
    ),
    withService((db) =>
      db
        .select({
          id: shipmentEvents.id,
          status: shipmentEvents.status,
          description: shipmentEvents.description,
          location: shipmentEvents.location,
          occurredAt: shipmentEvents.occurredAt,
        })
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipmentId))
        .orderBy(desc(shipmentEvents.occurredAt)),
    ),
  ]);
  const row = rows[0];
  if (!row) return undefined;
  const status = row.status as ShipmentStatus;
  return {
    id: row.id,
    provider: row.provider,
    status,
    statusLabel: shipmentStatusLabel(status),
    awb: row.awb,
    courierName: row.courierName,
    trackingUrl: row.trackingUrl,
    labelUrl: row.labelUrl,
    manifestUrl: row.manifestUrl,
    lastError: row.lastError,
    ndrReason: row.ndrReason,
    weightGrams: row.weightGrams,
    lengthCm: row.lengthCm,
    widthCm: row.widthCm,
    heightCm: row.heightCm,
    createdAt: row.createdAt,
    events,
  };
}

export async function getOrderLogisticsView(
  orderId: string,
): Promise<{ data?: OrderLogisticsView; error?: string }> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  const { order, lines } = await orderForShipment(storeId, orderId);
  if (!order) return { error: "Order not found." };

  const fulfilmentId =
    order.fulfilmentType === "delivery"
      ? await ensureFulfilmentOrder({
          storeId,
          orderId,
          locationId: order.locationId,
        })
      : null;
  const [connection, fulfilmentRows, shipmentRows] = await Promise.all([
    withService((db) =>
      db
        .select({
          id: storeLogisticsProviders.id,
          enabled: storeLogisticsProviders.enabled,
        })
        .from(storeLogisticsProviders)
        .where(
          and(
            eq(storeLogisticsProviders.storeId, storeId),
            eq(storeLogisticsProviders.provider, "shiprocket"),
          ),
        )
        .limit(1),
    ).catch(() => []),
    fulfilmentId
      ? withService((db) =>
          db
            .select({
              locationId: fulfilmentOrders.locationId,
              locationName: storeLocations.name,
              pickupCode: locationLogisticsMappings.externalPickupCode,
            })
            .from(fulfilmentOrders)
            .leftJoin(
              storeLocations,
              eq(storeLocations.id, fulfilmentOrders.locationId),
            )
            .leftJoin(
              locationLogisticsMappings,
              and(
                eq(
                  locationLogisticsMappings.locationId,
                  fulfilmentOrders.locationId,
                ),
                eq(locationLogisticsMappings.provider, "shiprocket"),
              ),
            )
            .where(eq(fulfilmentOrders.id, fulfilmentId))
            .limit(1),
        )
      : Promise.resolve([]),
    withService((db) =>
      db
        .select({ id: shipments.id })
        .from(shipments)
        .where(
          and(eq(shipments.storeId, storeId), eq(shipments.orderId, orderId)),
        )
        .orderBy(asc(shipments.createdAt)),
    ),
  ]);
  const views = await Promise.all(
    shipmentRows.map((row) => shipmentView(row.id)),
  );
  return {
    data: {
      connected: !!connection[0]?.enabled,
      mapped: !!fulfilmentRows[0]?.pickupCode,
      locationName: fulfilmentRows[0]?.locationName ?? null,
      defaults: parcelDefaults(lines),
      shipments: views.filter((item): item is ShipmentView => !!item),
    },
  };
}

export async function bookShiprocketShipment(
  orderId: string,
  parcelInput: ParcelInput,
): Promise<ActionResult> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  try {
    const parcel = {
      weightGrams: Math.round(positive(parcelInput.weightGrams, "Weight")),
      lengthCm: positive(parcelInput.lengthCm, "Length"),
      widthCm: positive(parcelInput.widthCm, "Width"),
      heightCm: positive(parcelInput.heightCm, "Height"),
    };
    const { order, lines } = await orderForShipment(storeId, orderId);
    if (!order) return { error: "Order not found." };
    if (order.fulfilmentType !== "delivery")
      return { error: "Pickup orders are not shipped." };
    if (["cancelled", "delivered"].includes(order.status)) {
      return { error: `A ${order.status} order cannot be shipped.` };
    }
    const physical = lines.filter((line) => line.requiresShipping);
    if (!physical.length) return { error: "This order has no physical items." };
    const address = (order.shippingAddress ?? {}) as Record<string, unknown>;
    const required = [
      "firstName",
      "addressLine1",
      "city",
      "state",
      "postalCode",
      "phone",
    ];
    const missing = required.filter((key) => !field(address, key));
    if (missing.length)
      return {
        error: "Complete the customer's delivery address before booking.",
      };

    const fulfilmentId = await ensureFulfilmentOrder({
      storeId,
      orderId,
      locationId: order.locationId,
    });
    const fulfilmentRows = await withService((db) =>
      db
        .select({
          locationId: fulfilmentOrders.locationId,
          pickupCode: locationLogisticsMappings.externalPickupCode,
        })
        .from(fulfilmentOrders)
        .leftJoin(
          locationLogisticsMappings,
          and(
            eq(
              locationLogisticsMappings.locationId,
              fulfilmentOrders.locationId,
            ),
            eq(locationLogisticsMappings.provider, "shiprocket"),
          ),
        )
        .where(eq(fulfilmentOrders.id, fulfilmentId))
        .limit(1),
    );
    const fulfilment = fulfilmentRows[0];
    if (!fulfilment?.pickupCode) {
      return {
        error:
          "Sync this fulfilment location with Shiprocket in Channels first.",
      };
    }
    const session = await getShiprocketSessionForStore(storeId);
    const idempotencyKey = `${orderId}:${fulfilmentId}:shiprocket:1`;
    const operationToken = crypto.randomUUID();
    const operationLeaseUntil = new Date(
      Date.now() + 10 * 60_000,
    ).toISOString();
    let shipmentRows = await withService((db) =>
      db
        .select()
        .from(shipments)
        .where(eq(shipments.idempotencyKey, idempotencyKey))
        .limit(1),
    );
    if (!shipmentRows[0]) {
      const codAmount =
        order.paymentMethod === "cash_on_delivery"
          ? Math.max(0, order.total - order.storeCreditUsed)
          : 0;
      await withService((db) =>
        db
          .insert(shipments)
          .values({
            storeId,
            orderId,
            fulfilmentOrderId: fulfilmentId,
            locationId: fulfilment.locationId,
            connectionId: session.id,
            provider: "shiprocket",
            status: "booking",
            idempotencyKey,
            weightGrams: parcel.weightGrams,
            lengthCm: parcel.lengthCm,
            widthCm: parcel.widthCm,
            heightCm: parcel.heightCm,
            codAmount,
            operationToken,
            operationLeaseUntil,
          })
          .onConflictDoNothing(),
      );
      shipmentRows = await withService((db) =>
        db
          .select()
          .from(shipments)
          .where(eq(shipments.idempotencyKey, idempotencyKey))
          .limit(1),
      );
    }
    let shipment = shipmentRows[0];
    if (!shipment) throw new Error("Could not create the shipment work item.");
    if (shipment.status === "cancelled") {
      return { error: "This shipment was cancelled and cannot be revived." };
    }
    if (
      [
        "ready_to_ship",
        "pickup_scheduled",
        "picked_up",
        "in_transit",
        "out_for_delivery",
        "delivered",
      ].includes(shipment.status)
    ) {
      return { success: true, shipment: await shipmentView(shipment.id) };
    }

    // The unique idempotency key prevents a second local row; this short lease
    // prevents two simultaneous requests from both owning the provider call on
    // that same row. A crashed worker becomes retryable after ten minutes.
    const claimed = await withService((db) =>
      db
        .update(shipments)
        .set({
          status: "booking",
          operationToken,
          operationLeaseUntil,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(shipments.id, shipment!.id),
            or(
              eq(shipments.operationToken, operationToken),
              isNull(shipments.operationToken),
              isNull(shipments.operationLeaseUntil),
              lt(shipments.operationLeaseUntil, new Date().toISOString()),
            ),
          ),
        )
        .returning({ id: shipments.id }),
    );
    if (!claimed.length) {
      return {
        error: "This shipment is already being booked. Refresh in a moment.",
        shipment: await shipmentView(shipment.id),
      };
    }
    await withService((db) =>
      db
        .insert(shipmentItems)
        .values(
          physical.map((line) => ({
            shipmentId: shipment!.id,
            orderItemId: line.id,
            quantity: line.quantity,
          })),
        )
        .onConflictDoNothing(),
    );

    try {
      if (!shipment.externalShipmentId) {
        const created = await createShiprocketOrder(session.token, {
          order_id: `SM-${order.orderRef}-${shipment.id.slice(0, 8)}`.slice(
            0,
            50,
          ),
          order_date: order.createdAt.replace("T", " ").slice(0, 19),
          pickup_location: fulfilment.pickupCode,
          billing_customer_name: field(address, "firstName"),
          billing_last_name: field(address, "lastName"),
          billing_address: field(address, "addressLine1"),
          billing_address_2: field(address, "addressLine2"),
          billing_city: field(address, "city"),
          billing_pincode: field(address, "postalCode").replace(/\s/g, ""),
          billing_state: field(address, "state"),
          billing_country: field(address, "country") || "India",
          billing_email: field(address, "email") || session.email,
          billing_phone: field(address, "phone")
            .replace(/[^0-9]/g, "")
            .slice(-10),
          shipping_is_billing: true,
          order_items: physical.map((line) => ({
            name: line.name.slice(0, 100),
            sku: (line.sku || line.id).slice(0, 50),
            units: line.quantity,
            selling_price: line.price,
            tax: line.taxRate ?? 0,
            ...(line.hsn ? { hsn: line.hsn } : {}),
          })),
          payment_method:
            order.paymentMethod === "cash_on_delivery" ? "COD" : "Prepaid",
          shipping_charges: order.shipping,
          total_discount: order.discount,
          sub_total: order.subtotal,
          length: parcel.lengthCm,
          breadth: parcel.widthCm,
          height: parcel.heightCm,
          weight: parcel.weightGrams / 1000,
        });
        await withService((db) =>
          db
            .update(shipments)
            .set({
              externalOrderId: created.orderId,
              externalShipmentId: created.shipmentId,
              status: "booking",
              lastError: null,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(shipments.id, shipment!.id)),
        );
        shipment = {
          ...shipment,
          externalOrderId: created.orderId,
          externalShipmentId: created.shipmentId,
        };
      }
      if (!shipment.awb) {
        const awb = await assignShiprocketAwb(
          session.token,
          shipment.externalShipmentId!,
          parcelInput.courierId,
        );
        await withService((db) =>
          db
            .update(shipments)
            .set({
              awb: awb.awb,
              courierId: awb.courierId,
              courierName: awb.courierName,
              trackingUrl: `https://shiprocket.co/tracking/${encodeURIComponent(awb.awb)}`,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(shipments.id, shipment!.id)),
        );
        shipment = {
          ...shipment,
          awb: awb.awb,
          courierId: awb.courierId,
          courierName: awb.courierName,
        };
      }
      let labelUrl = shipment.labelUrl;
      if (!labelUrl) {
        labelUrl = await generateShiprocketLabel(
          session.token,
          shipment.externalShipmentId!,
        );
      }
      await withService((db) =>
        db
          .update(shipments)
          .set({
            status: "ready_to_ship",
            labelUrl,
            lastError: null,
            operationToken: null,
            operationLeaseUntil: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(shipments.id, shipment!.id)),
      );
      await markFulfilmentInProgress(fulfilmentId);
      await withService((db) =>
        db
          .update(orders)
          .set({ status: "processing", updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(orders.id, orderId),
              eq(orders.storeId, storeId),
              inArray(orders.status, ["pending", "confirmed", "processing"]),
            ),
          ),
      );
      await recordShipmentTrackingUpdate(shipment.id, {
        status: "ready_to_ship",
        externalStatus: "AWB assigned",
        externalCode: "storemink-booked",
        description: "Shipment booked and label generated",
        location: null,
        occurredAt: new Date().toISOString(),
        awb: shipment.awb,
        externalShipmentId: shipment.externalShipmentId,
        payload: {},
      });
      revalidatePath("/dashboard/orders");
      return { success: true, shipment: await shipmentView(shipment.id) };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Shiprocket booking failed.";
      await withService((db) =>
        db
          .update(shipments)
          .set({
            status: "error",
            lastError: message,
            operationToken: null,
            operationLeaseUntil: null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(shipments.id, shipment!.id)),
      );
      return { error: message, shipment: await shipmentView(shipment.id) };
    }
  } catch (error) {
    console.error("bookShiprocketShipment:", error);
    return {
      error:
        error instanceof Error ? error.message : "Could not book shipment.",
    };
  }
}

async function scopedShipment(storeId: string, shipmentId: string) {
  const rows = await withService((db) =>
    db
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.storeId, storeId)))
      .limit(1),
  );
  return rows[0];
}

export async function scheduleShipmentPickup(
  shipmentId: string,
): Promise<ActionResult> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  const shipment = await scopedShipment(storeId, shipmentId);
  if (!shipment?.externalShipmentId || shipment.provider !== "shiprocket") {
    return { error: "This Shiprocket shipment is not ready for pickup." };
  }
  try {
    const session = await getShiprocketSessionForStore(storeId);
    await scheduleShiprocketPickup(session.token, shipment.externalShipmentId);
    let manifestUrl: string | null = null;
    try {
      manifestUrl = await generateShiprocketManifest(
        session.token,
        shipment.externalShipmentId,
      );
    } catch {
      // Shiprocket can generate the manifest later; pickup itself succeeded.
    }
    const now = new Date().toISOString();
    await withService((db) =>
      db
        .update(shipments)
        .set({
          status: "pickup_scheduled",
          pickupScheduledAt: now,
          manifestUrl,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(shipments.id, shipmentId)),
    );
    await recordShipmentTrackingUpdate(shipmentId, {
      status: "pickup_scheduled",
      externalStatus: "Pickup scheduled",
      externalCode: "storemink-pickup",
      description: "Courier pickup scheduled",
      location: null,
      occurredAt: now,
      awb: shipment.awb,
      externalShipmentId: shipment.externalShipmentId,
      payload: {},
    });
    revalidatePath("/dashboard/orders");
    return { success: true, shipment: await shipmentView(shipmentId) };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not schedule pickup.",
    };
  }
}

export async function retryShiprocketShipment(
  shipmentId: string,
): Promise<ActionResult> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  const shipment = await scopedShipment(storeId, shipmentId);
  if (!shipment || shipment.provider !== "shiprocket") {
    return { error: "Shiprocket shipment not found." };
  }
  if (shipment.status !== "error" && shipment.status !== "booking") {
    return { error: "This shipment does not need a booking retry." };
  }
  return bookShiprocketShipment(shipment.orderId, {
    weightGrams: shipment.weightGrams,
    lengthCm: shipment.lengthCm,
    widthCm: shipment.widthCm,
    heightCm: shipment.heightCm,
    courierId: shipment.courierId ?? undefined,
  });
}

export async function refreshShipmentTracking(
  shipmentId: string,
): Promise<ActionResult> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  const shipment = await scopedShipment(storeId, shipmentId);
  if (!shipment?.awb || shipment.provider !== "shiprocket")
    return { error: "No Shiprocket AWB to track." };
  try {
    const session = await getShiprocketSessionForStore(storeId, false);
    const raw = await trackShiprocketAwb(session.token, shipment.awb);
    for (const update of parseShiprocketTracking(raw)) {
      await recordShipmentTrackingUpdate(shipmentId, update);
    }
    revalidatePath("/dashboard/orders");
    return { success: true, shipment: await shipmentView(shipmentId) };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Tracking refresh failed.",
    };
  }
}

export async function submitShipmentNdrAction(
  shipmentId: string,
  action: "re-attempt" | "return",
  commentsInput: string,
): Promise<ActionResult> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  const shipment = await scopedShipment(storeId, shipmentId);
  if (
    !shipment?.awb ||
    shipment.provider !== "shiprocket" ||
    shipment.status !== "ndr"
  ) {
    return { error: "This shipment does not have an actionable NDR." };
  }
  const comments = commentsInput.trim().slice(0, 500);
  try {
    const session = await getShiprocketSessionForStore(storeId);
    await actOnShiprocketNdr(session.token, shipment.awb, action, comments);
    await withService((db) =>
      db
        .update(shipments)
        .set({
          status: action === "return" ? "rto_initiated" : "in_transit",
          ndrReason: comments || null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(shipments.id, shipmentId)),
    );
    revalidatePath("/dashboard/orders");
    return { success: true, shipment: await shipmentView(shipmentId) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "NDR action failed.",
    };
  }
}

export async function cancelShipment(
  shipmentId: string,
): Promise<ActionResult> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  const shipment = await scopedShipment(storeId, shipmentId);
  if (!shipment) return { error: "Shipment not found." };
  if (
    ["picked_up", "in_transit", "out_for_delivery", "delivered"].includes(
      shipment.status,
    )
  ) {
    return {
      error:
        "A collected parcel must be handled through Shiprocket support or NDR.",
    };
  }
  try {
    if (shipment.provider === "shiprocket" && shipment.awb) {
      const session = await getShiprocketSessionForStore(storeId, false);
      await cancelShiprocketAwb(session.token, shipment.awb);
    }
    await withService((db) =>
      db
        .update(shipments)
        .set({ status: "cancelled", updatedAt: new Date().toISOString() })
        .where(eq(shipments.id, shipmentId)),
    );
    revalidatePath("/dashboard/orders");
    return { success: true, shipment: await shipmentView(shipmentId) };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not cancel shipment.",
    };
  }
}

export async function createManualShipment(
  orderId: string,
  input: ParcelInput & {
    courierName: string;
    awb: string;
    trackingUrl?: string;
  },
): Promise<ActionResult> {
  if (!(await getManagerIdentity("orders")))
    return { error: "Not authenticated." };
  const storeId = await getActingStoreId();
  try {
    const courierName = input.courierName.trim().slice(0, 100);
    const awb = input.awb.trim().slice(0, 100);
    if (!courierName || !awb)
      return { error: "Enter the courier and tracking number." };
    const { order, lines } = await orderForShipment(storeId, orderId);
    if (!order || order.fulfilmentType !== "delivery")
      return { error: "Delivery order not found." };
    const physical = lines.filter((line) => line.requiresShipping);
    if (!physical.length) return { error: "This order has no physical items." };
    const fulfilmentId = await ensureFulfilmentOrder({
      storeId,
      orderId,
      locationId: order.locationId,
    });
    const idempotencyKey = `${orderId}:${fulfilmentId}:manual:1`;
    const rows = await withService((db) =>
      db
        .insert(shipments)
        .values({
          storeId,
          orderId,
          fulfilmentOrderId: fulfilmentId,
          locationId: order.locationId,
          provider: "manual",
          status: "picked_up",
          idempotencyKey,
          awb,
          courierName,
          trackingUrl: input.trackingUrl?.trim() || null,
          weightGrams: Math.round(positive(input.weightGrams, "Weight")),
          lengthCm: positive(input.lengthCm, "Length"),
          widthCm: positive(input.widthCm, "Width"),
          heightCm: positive(input.heightCm, "Height"),
          pickedUpAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: shipments.id }),
    );
    let id = rows[0]?.id;
    if (!id) {
      const existing = await withService((db) =>
        db
          .select({ id: shipments.id })
          .from(shipments)
          .where(eq(shipments.idempotencyKey, idempotencyKey))
          .limit(1),
      );
      id = existing[0]?.id;
    }
    if (!id) throw new Error("Could not save manual shipment.");
    await withService((db) =>
      db
        .insert(shipmentItems)
        .values(
          physical.map((line) => ({
            shipmentId: id!,
            orderItemId: line.id,
            quantity: line.quantity,
          })),
        )
        .onConflictDoNothing(),
    );
    await recordShipmentTrackingUpdate(id, {
      status: "picked_up",
      externalStatus: "Handed to courier",
      externalCode: "manual",
      description: `Handed to ${courierName}`,
      location: null,
      occurredAt: new Date().toISOString(),
      awb,
      externalShipmentId: null,
      payload: {},
    });
    revalidatePath("/dashboard/orders");
    return { success: true, shipment: await shipmentView(id) };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not create shipment.",
    };
  }
}
