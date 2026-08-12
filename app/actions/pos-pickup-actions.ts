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
//
// ★ A `pay_at_store` collection is also where MONEY changes hands, and until
// 2026-08-06 none of it was recorded: the hand-over flipped payment_status to
// 'paid' and wrote no `order_payments` row and no `orders.shift_id`. Shift
// reconciliation reads cash as `order_payments` joined to orders ON shift_id,
// so the notes were physically in the drawer and contributed 0 to expectedCash
// — every drawer reported OVER by the full value of every collection it took,
// every shift, and those sales were missing from the Z-report's count and gross
// as well. That is the mirror of the two bugs lib/pos/shifts.ts already guards
// (double-counted change, cash refunds), which both reported SHORT.

import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  orderItems,
  orderPayments,
  orders,
  stockReservations,
  storeLocations,
} from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { commitHold } from "@/lib/inventory/reservations";
import { emitEvent } from "@/lib/notifications/record";
import { formatAddressLine } from "@/lib/locations/address";
import {
  formatCollectionCode,
  isCollectionCode,
  normalizeCollectionCode,
} from "@/lib/fulfilment/collection-code";
import { amountDueAtCollection } from "@/lib/pos/pickup-payment";
import {
  settleTenders,
  validateTenderShape,
  type PosTender,
} from "@/lib/pos/tenders";
import { currentShiftIdFor } from "./pos-shift-actions";
import { getStoreSettings } from "@/lib/settings/resolve";

/**
 * The shop an order is waiting at, returned alongside the claim itself.
 *
 * Both hand-over paths tell the customer something about WHERE, so both read
 * it the same way — and reading it in the same statement that claims the row
 * means the name can't be fetched for an order the claim didn't actually win.
 */
const pickupShopColumns = {
  location_name: sql<string | null>`(
    select l.name from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
  location_address: sql<Record<string, unknown> | null>`(
    select l.address from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
};

export interface PickupOrder {
  id: string;
  orderRef: string;
  customerName: string | null;
  itemCount: number;
  total: number;
  /** Still owed at the counter — 0 when it was paid online. Drives whether the
   *  queue takes a payment before handing over. */
  amountDue: number;
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
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          created_at: orders.createdAt,
          expires_at: orders.pickupExpiresAt,
          status: orders.pickupStatus,
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

    // Counted separately, not as a correlated subquery: interpolating columns
    // into sql`` drops their table qualification, so `where "order_id" = "id"`
    // resolves both names inside order_items and silently counts zero.
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const countRows = await withService((db) =>
        db
          .select({ order_id: orderItems.orderId, n: count() })
          .from(orderItems)
          .where(
            inArray(
              orderItems.orderId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(orderItems.orderId),
      );
      for (const c of countRows) counts.set(c.order_id, Number(c.n) || 0);
    }

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
          itemCount: counts.get(r.id) ?? 0,
          total: Number(r.total) || 0,
          // The SAME helper markCollected charges with, so the counter can
          // never quote one figure and take another.
          amountDue: amountDueAtCollection({
            paymentMethod: r.payment_method,
            paymentStatus: r.payment_status,
            total: r.total,
          }),
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

const NOT_WAITING =
  "That order isn't waiting for collection here. It may already have been collected.";

/**
 * Hand the order over, taking the money if any is still owed.
 *
 * Claims awaiting/ready → collected CONDITIONALLY, so two staff scanning the
 * same order at once hand it over once. Only then are the holds committed —
 * doing it the other way round could take stock for an order somebody else had
 * already collected.
 */
export async function markCollected(
  orderId: string,
  /** What the customer handed over at the counter. Empty for an order already
   *  paid online, which is most of them. */
  tenders: PosTender[] = [],
): Promise<{ success?: boolean; error?: string; changeDue?: number }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid order." };

  // ── What does this order still owe? ──────────────────────────────────────
  // Read BEFORE the claim. A tender that doesn't cover the total has to be
  // refused while the goods are still on the shelf: claiming first and then
  // refusing the payment is the one outcome with no recovery, because the order
  // reads as collected and the money was never taken.
  let owed:
    | {
        total: unknown;
        payment_method: string | null;
        payment_status: string | null;
      }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({
          total: orders.total,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
        })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            eq(orders.pickupLocationId, op.locationId),
            or(
              eq(orders.pickupStatus, "awaiting"),
              eq(orders.pickupStatus, "ready"),
            ),
          ),
        )
        .limit(1),
    );
    owed = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't read the order.") };
  }
  if (!owed) return { error: NOT_WAITING };

  const due = amountDueAtCollection({
    paymentMethod: owed.payment_method,
    paymentStatus: owed.payment_status,
    total: owed.total as number | string | null,
  });

  let shiftId: string | null = null;
  let change = 0;
  if (due > 0) {
    const bad = validateTenderShape(
      tenders,
      `Take the ₹${due.toLocaleString("en-IN")} owed on this order before handing it over.`,
    );
    if (bad) return { error: bad };
    const settled = settleTenders(tenders, due);
    if ("error" in settled) return { error: settled.error };
    change = settled.change;

    // Which drawer this money belongs to. Stamped on the order in the SAME
    // statement as the claim, so a collection cannot be recorded without its
    // cash landing somewhere — the gap this whole change exists to close.
    shiftId = await currentShiftIdFor(op.locationId);
    if (!shiftId) {
      // The SAME rule the sell path applies, deliberately: taking payment at a
      // counter IS selling, so the money gets exactly the home a counter sale's
      // money gets. With the setting on, the hand-over waits for a drawer —
      // nothing is lost, the goods stay held. With it off it goes unattributed,
      // which reconciliation surfaces rather than hides (currentShiftIdFor).
      // Inventing a third policy here is how the two counters drift apart.
      let requireShift = false;
      try {
        requireShift =
          (await getStoreSettings())["pos.requireOpenShift"] === true;
      } catch {
        // A settings read failure must not refuse a customer standing at the
        // counter — the same posture getCurrentShift takes.
        requireShift = false;
      }
      if (requireShift) {
        return {
          error: "Open a shift before taking payment at the counter.",
        };
      }
    }
  } else if (Array.isArray(tenders) && tenders.length > 0) {
    // Refused, not ignored. Recording tenders against an order that owes
    // nothing would inflate the drawer's expected cash with money that was
    // never handed over, reporting it SHORT — the very failure being fixed,
    // pointed the other way.
    return { error: "This order is already paid — no payment is due here." };
  }

  let claimed:
    | {
        id: string;
        order_ref: string | null;
        customer_id: string | null;
        location_name: string | null;
        location_address: Record<string, unknown> | null;
      }
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
          // "Pay at store" means the money changes hands at the counter — so
          // handing the order over IS the payment. Only that method is
          // settled here: an order already paid online must not be touched,
          // and one that failed must not be marked paid by a hand-over.
          paymentStatus: sql`case when ${orders.paymentMethod} = 'pay_at_store'
                                  and ${orders.paymentStatus} = 'pending'
                             then 'paid' else ${orders.paymentStatus} end`,
          // ONLY when money was taken here. An order paid online weeks ago that
          // happens to be collected during this shift never touched this
          // drawer, and stamping it would pull its whole total into the
          // Z-report's gross as takings the till never took.
          ...(due > 0 && shiftId ? { shiftId } : {}),
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
          ...pickupShopColumns,
        }),
    );
    claimed = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't complete the collection.") };
  }

  if (!claimed) return { error: NOT_WAITING };

  // Record the tender. AFTER the claim, so a second tap — which matches zero
  // rows — cannot write a second payment for money handed over once.
  if (due > 0) {
    try {
      await withService((db) =>
        db.insert(orderPayments).values(
          tenders.map((t) => ({
            orderId,
            storeId: op.storeId,
            method: t.method,
            amount: t.amount,
            tendered: t.method === "cash" ? (t.tendered ?? t.amount) : null,
            // Change is a property of the COLLECTION, replicated onto each cash
            // row exactly as placePosSale does — netCashFromSales groups by
            // order and takes the max, so it is subtracted once.
            changeDue: t.method === "cash" ? change : null,
            reference: t.reference?.slice(0, 120) ?? null,
          })),
        ),
      );
    } catch (err) {
      // The customer has paid and is holding the goods; the collection is NOT
      // undone. Log loudly — this is the one path that can still leave cash
      // unrecorded, and it is now an error rather than the design.
      console.error("markCollected (payments):", err);
    }
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
    // Declared on this event too — an empty "Where" row on a thank-you is the
    // same defect as an empty address on the ready notice.
    payload: { pickupLocation: claimed.location_name ?? "" },
  });

  revalidatePath("/pos/pickups");
  return { success: true, changeDue: change };
}

/** Tell the shopper it's packed and waiting. */
export async function markReadyForPickup(
  orderId: string,
): Promise<{ success?: boolean; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  // ★ MANAGER AND ABOVE (roadmap Step 3). Marking an order ready is what tells
  // a customer to travel, so it should be someone who has actually seen the
  // box — not anyone who happens to be on the till. Handing it over stays
  // `sell`: that is a cashier's job, with the customer standing there.
  //
  // Safe to tighten because no store had pickup enabled when this shipped
  // (owner confirmed 2026-08-09) — there is no live behaviour to preserve
  // (invariant 1).
  if (!posCan(op.role, "fulfil_pickup")) {
    return {
      error: "Only a manager can mark a collection order ready.",
    };
  }

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
          pickup_code: orders.pickupCode,
          ...pickupShopColumns,
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
      // ★ WITHOUT THESE THE EMAIL IS USELESS. "Ready to collect" that doesn't
      // say WHERE is the one message in the pickup flow whose entire job is an
      // address — and the template declares both tokens, so an emitter that
      // doesn't supply them doesn't produce a shorter email, it produces
      // "Pickup location" and "Pickup address" as empty labelled rows.
      payload: {
        pickupLocation: row.location_name ?? "",
        pickupAddress: formatAddressLine(row.location_address),
        // ★ WITHOUT THIS the email says "ready" and gives them nothing to
        // present. The code is text so it renders in every client; the QR is
        // on the collection page the CTA links to.
        collectionCode: row.pickup_code
          ? formatCollectionCode(row.pickup_code)
          : "",
      },
    });
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't update the order.") };
  }

  revalidatePath("/pos/pickups");
  return { success: true };
}

/**
 * Find a collection by the code the customer is holding up (roadmap Step 3).
 *
 * ★ THE CODE IS A LOOKUP KEY, NOT AN AUTHORISATION. The operator is already
 * authenticated and device-bound; this only saves them typing an order
 * reference. Scoped to the STORE, and the result says which shop it belongs to
 * rather than pretending it doesn't exist — a customer standing at Andheri with
 * an order waiting at Bandra needs to be told that, not "not found".
 */
export async function findPickupByCode(
  rawCode: string,
): Promise<{ order?: PickupOrder; otherLocation?: string; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  const code = normalizeCollectionCode(rawCode);
  // Cheap shape check first, so a scanner pointed at a milk carton never
  // becomes a database lookup.
  if (!isCollectionCode(code)) {
    return { error: "That doesn't look like a collection code." };
  }

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
          pickup_location_id: orders.pickupLocationId,
          // What is still owed depends on both of these — see below.
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          location_name: sql<string | null>`(
            select l.name from ${storeLocations} l
             where l.id = ${orders.pickupLocationId}
          )`,
        })
        .from(orders)
        .where(and(eq(orders.storeId, op.storeId), eq(orders.pickupCode, code)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return { error: "No collection found for that code." };

    // Belongs to another shop in the same store — say which, so the customer
    // can be sent to the right place.
    if (row.pickup_location_id !== op.locationId) {
      return { otherLocation: row.location_name ?? "another shop" };
    }

    const addr = (row.shipping_address ?? {}) as Record<string, unknown>;
    const name =
      [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() || null;

    // ★ THE REAL FIGURES, NOT ZEROES. Both of these were hardcoded to 0 on the
    // reasoning that a scan "lands on the order itself, where the caller re-reads
    // what it needs" — but nothing re-reads: the scanned order is rendered by the
    // SAME row component as the queue. So a pay-at-store collection scanned at
    // the counter drew "Hand over" instead of "Take payment" and skipped the
    // tender pad, and every scanned order read "0 items".
    //
    // No money could be lost — markCollected re-reads what is owed server-side
    // and refuses a hand-over that doesn't cover it (validateTenderShape) — but
    // the button described the wrong action, so the cashier tapped expecting to
    // hand goods over and got an error about money instead.
    const itemRows = await withService((db) =>
      db
        .select({ n: count() })
        .from(orderItems)
        .where(eq(orderItems.orderId, row.id)),
    ).catch(() => []);

    return {
      order: {
        id: row.id,
        orderRef: row.order_ref ?? "",
        customerName: name,
        itemCount: Number(itemRows[0]?.n) || 0,
        total: Number(row.total) || 0,
        placedAt: row.created_at,
        expiresAt: row.expires_at,
        // NOT defaulted to "awaiting": that would present an expired or
        // already-collected order as live, which is the whole bug being fixed.
        // collectionState() reads an unknown status as "gone" (no button).
        status: row.status ?? "",
        amountDue: amountDueAtCollection({
          paymentMethod: row.payment_method,
          paymentStatus: row.payment_status,
          total: row.total,
        }),
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't look that code up.") };
  }
}
