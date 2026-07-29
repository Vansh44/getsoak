"use server";

// The collection queue at a shop (roadmap Phase F).
//
// A pickup order's stock is HELD at this location, not sold. Handing it over is
// what turns the hold into a sale — which is why collection goes through
// `commitHold` rather than touching stock directly (roadmap invariant 1).
//
// Everything is scoped to the OPERATOR's location. A cashier at Delhi hands over
// Delhi's orders; naming another shop is not possible because the location is
// never taken from the client.

import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { orderItems, orders, stockReservations } from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { commitHold } from "@/lib/inventory/reservations";
import { emitEvent } from "@/lib/notifications/record";

export interface PickupOrder {
  id: string;
  orderRef: string;
  customerName: string | null;
  itemCount: number;
  total: number;
  placedAt: string;
  expiresAt: string | null;
  status: string;
}

function fail(msg: string) {
  return { orders: [] as PickupOrder[], error: msg };
}

/** Orders waiting to be collected at THIS shop, oldest first. */
export async function getPickupQueue(
  query?: string,
): Promise<{ orders: PickupOrder[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return fail("Not signed in.");
  if (!posCan(op.role, "sell")) return fail("Not allowed.");

  const q = (query ?? "").trim().slice(0, 60);

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          shipping_address: orders.shippingAddress,
          total: orders.total,
          created_at: orders.createdAt,
          expires_at: orders.pickupExpiresAt,
          status: orders.pickupStatus,
          items: sql<number>`(select count(*) from ${orderItems} where ${orderItems.orderId} = ${orders.id})`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, op.storeId),
            eq(orders.fulfilmentType, "pickup"),
            eq(orders.pickupLocationId, op.locationId),
            // Collected and expired orders leave the queue — it is a list of
            // work, not a history.
            or(
              eq(orders.pickupStatus, "awaiting"),
              eq(orders.pickupStatus, "ready"),
            ),
            q
              ? ilike(orders.orderRef, `%${q.replace(/[%_]/g, "\\$&")}%`)
              : undefined,
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(100),
    );

    return {
      orders: rows.map((r) => {
        const addr = (r.shipping_address ?? {}) as Record<string, unknown>;
        const name =
          [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() ||
          null;
        return {
          id: r.id,
          orderRef: r.order_ref ?? "",
          customerName: name,
          itemCount: Number(r.items) || 0,
          total: Number(r.total) || 0,
          placedAt: r.created_at,
          expiresAt: r.expires_at,
          status: r.status ?? "awaiting",
        };
      }),
    };
  } catch (err) {
    return fail(dbErrorMessage(err, "Couldn't load the collection queue."));
  }
}

/**
 * Hand the order over.
 *
 * Claims awaiting/ready → collected CONDITIONALLY, so two staff scanning the
 * same order at once hand it over once. Only then are the holds committed —
 * doing it the other way round could take stock for an order somebody else had
 * already collected.
 */
export async function markCollected(
  orderId: string,
): Promise<{ success?: boolean; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid order." };

  let claimed:
    | { id: string; order_ref: string | null; customer_id: string | null }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .update(orders)
        .set({
          pickupStatus: "collected",
          collectedAt: sql`now()`,
          collectedBy: op.staffId ?? op.name,
          status: "completed",
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            // The operator's own shop — never a location from the client.
            eq(orders.pickupLocationId, op.locationId),
            or(
              eq(orders.pickupStatus, "awaiting"),
              eq(orders.pickupStatus, "ready"),
            ),
          ),
        )
        .returning({
          id: orders.id,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
        }),
    );
    claimed = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't complete the collection.") };
  }

  if (!claimed) {
    return {
      error:
        "That order isn't waiting for collection here. It may already have been collected.",
    };
  }

  // Turn every hold for this order into a real sale. commitHold is idempotent,
  // so a retry after a partial failure cannot double-decrement.
  try {
    const holds = await withService((db) =>
      db
        .select({ id: stockReservations.id })
        .from(stockReservations)
        .where(
          and(
            eq(stockReservations.ownerType, "pickup"),
            eq(stockReservations.ownerId, orderId),
            eq(stockReservations.status, "held"),
          ),
        ),
    );
    for (const h of holds) await commitHold(h.id, orderId);
  } catch (err) {
    // The customer has the goods — the collection is NOT undone. A stranded
    // hold is visible in the reservations table and swept later; refusing here
    // would leave the shop unable to record a hand-over that happened.
    console.error("markCollected (holds):", err);
  }

  emitEvent({
    type: "order.collected",
    storeId: op.storeId,
    locationId: op.locationId,
    actor: { type: "admin", id: op.staffId ?? null, label: op.name },
    subject: { type: "order", id: orderId, label: claimed.order_ref ?? "" },
    customerId: claimed.customer_id,
  });

  revalidatePath("/pos/pickups");
  return { success: true };
}

/** Tell the shopper it's packed and waiting. */
export async function markReadyForPickup(
  orderId: string,
): Promise<{ success?: boolean; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  try {
    const rows = await withService((db) =>
      db
        .update(orders)
        .set({ pickupStatus: "ready" })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            eq(orders.pickupLocationId, op.locationId),
            eq(orders.pickupStatus, "awaiting"),
          ),
        )
        .returning({
          id: orders.id,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
        }),
    );
    const row = rows[0];
    if (!row) return { error: "That order isn't waiting here." };

    emitEvent({
      type: "order.ready_for_pickup",
      storeId: op.storeId,
      locationId: op.locationId,
      actor: { type: "admin", id: op.staffId ?? null, label: op.name },
      subject: { type: "order", id: orderId, label: row.order_ref ?? "" },
      customerId: row.customer_id,
    });
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't update the order.") };
  }

  revalidatePath("/pos/pickups");
  return { success: true };
}
