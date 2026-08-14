import "server-only";

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  fulfilmentOrderItems,
  fulfilmentOrders,
  orderItems,
  orders,
  storeLocations,
} from "@/drizzle/schema";
import {
  isLocationType,
  locationCan,
  normalizeCapabilities,
} from "@/lib/locations/capabilities";

/**
 * Create (or self-heal) the work object assigned to an order's stock location.
 * Checkout calls this after its lines are durable. Old orders and a deployment
 * that briefly ran before the migration are repaired by the booking action.
 */
export async function ensureFulfilmentOrder(input: {
  storeId: string;
  orderId: string;
  locationId?: string | null;
}): Promise<string> {
  let locationId = input.locationId ?? null;

  const existing = await withService((db) =>
    db
      .select({ id: fulfilmentOrders.id })
      .from(fulfilmentOrders)
      .where(
        and(
          eq(fulfilmentOrders.storeId, input.storeId),
          eq(fulfilmentOrders.orderId, input.orderId),
        ),
      )
      .limit(1),
  );
  let fulfilmentId = existing[0]?.id;

  if (!fulfilmentId) {
    if (!locationId) {
      const [orderRow, locationRows] = await Promise.all([
        withService((db) =>
          db
            .select({ location_id: orders.locationId })
            .from(orders)
            .where(
              and(
                eq(orders.id, input.orderId),
                eq(orders.storeId, input.storeId),
              ),
            )
            .limit(1),
        ),
        withService((db) =>
          db
            .select({
              id: storeLocations.id,
              type: storeLocations.type,
              capabilities: storeLocations.capabilities,
              isDefault: storeLocations.isDefault,
            })
            .from(storeLocations)
            .where(
              and(
                eq(storeLocations.storeId, input.storeId),
                eq(storeLocations.active, true),
              ),
            ),
        ),
      ]);
      const eligible = locationRows.filter((location) => {
        if (!isLocationType(location.type)) return false;
        return locationCan(
          normalizeCapabilities(location.capabilities, location.type),
          "online_fulfil",
        );
      });
      locationId =
        orderRow[0]?.location_id ??
        eligible.find((location) => location.isDefault)?.id ??
        eligible[0]?.id ??
        null;
    }
    if (!locationId) {
      throw new Error("Assign this order to a fulfilment location first.");
    }

    const inserted = await withService((db) =>
      db
        .insert(fulfilmentOrders)
        .values({
          storeId: input.storeId,
          orderId: input.orderId,
          locationId,
          status: "open",
        })
        .onConflictDoNothing()
        .returning({ id: fulfilmentOrders.id }),
    );
    fulfilmentId = inserted[0]?.id;
    if (!fulfilmentId) {
      const rows = await withService((db) =>
        db
          .select({ id: fulfilmentOrders.id })
          .from(fulfilmentOrders)
          .where(
            and(
              eq(fulfilmentOrders.storeId, input.storeId),
              eq(fulfilmentOrders.orderId, input.orderId),
            ),
          )
          .limit(1),
      );
      fulfilmentId = rows[0]?.id;
    }
  }
  if (!fulfilmentId) throw new Error("Could not create the fulfilment order.");

  const lines = await withService((db) =>
    db
      .select({ id: orderItems.id, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId)),
  );
  if (lines.length > 0) {
    await withService((db) =>
      db
        .insert(fulfilmentOrderItems)
        .values(
          lines.map((line) => ({
            fulfilmentOrderId: fulfilmentId!,
            orderItemId: line.id,
            quantity: line.quantity,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  return fulfilmentId;
}

export async function markFulfilmentInProgress(fulfilmentId: string) {
  await withService((db) =>
    db
      .update(fulfilmentOrders)
      .set({ status: "in_progress", updatedAt: new Date().toISOString() })
      .where(eq(fulfilmentOrders.id, fulfilmentId)),
  );
}

export async function markFulfilmentComplete(fulfilmentId: string) {
  const now = new Date().toISOString();
  await withService((db) =>
    db
      .update(fulfilmentOrders)
      .set({ status: "fulfilled", fulfilledAt: now, updatedAt: now })
      .where(eq(fulfilmentOrders.id, fulfilmentId)),
  );
}
