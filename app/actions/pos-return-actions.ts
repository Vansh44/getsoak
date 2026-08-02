"use server";

// Returns at the till (roadmap Phase G / POS 5).
//
// The mirror of `placePosSale`, and the same trust boundary: the operator is
// resolved server-side, the sale is re-read from the DB, the refund is
// RECOMPUTED from the stored snapshot, and only then is anything written. The
// client says which lines and how many — never how much money.
//
// ── Scope ──────────────────────────────────────────────────────────────────
// In-store returns of sales rung at THIS location, refunded at the counter:
// cash from the drawer, or the shop's own card machine. No gateway call, so
// this does not wait on the Razorpay refund work.
//
// Returning at a DIFFERENT shop from the one that sold is deliberately out —
// it raises whose shelf gains the stock and whose drawer pays, and getting
// that wrong means refunding cash from a till that never took it. It belongs
// with the online-order returns (BORIS) that need the gateway anyway.

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  orderItems,
  orderRefunds,
  orderReturnItems,
  orderReturns,
  orders,
} from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { currentShiftIdFor } from "./pos-shift-actions";
import {
  refundBreakdown,
  remainingQty,
  type ReturnableLine,
} from "@/lib/pos/returns";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";

/** Tenders a shop can hand money back through at the counter. */
const REFUND_METHODS = ["cash", "card", "upi"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export type ReturnCondition = "sellable" | "damaged";

export interface ReturnableSaleLine {
  id: string;
  productId: string | null;
  variantId: string | null;
  name: string;
  variantName: string | null;
  quantity: number;
  returned: number;
  remaining: number;
  unitPrice: number;
  lineTotal: number;
  taxAmount: number;
}

export interface ReturnableSale {
  orderId: string;
  receiptNo: string;
  orderRef: string;
  createdAt: string;
  total: number;
  /** The order-level discount only — line markdowns are already inside each
   *  line's total (see lib/pos/returns.ts). */
  orderDiscount: number;
  paymentMethod: string;
  lines: ReturnableSaleLine[];
}

/** The sale, with how much of each line is still returnable. */
export async function getReturnableSale(
  orderId: string,
): Promise<{ sale?: ReturnableSale; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "refund")) {
    return { error: "You don't have permission to take returns." };
  }
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid sale." };

  try {
    const data = await withService(async (db) => {
      const orderRows = await db
        .select({
          id: orders.id,
          receipt_no: orders.receiptNo,
          order_ref: orders.orderRef,
          created_at: orders.createdAt,
          total: orders.total,
          discount: orders.discount,
          payment_method: orders.paymentMethod,
        })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            // The operator's own shop, never a location from the client.
            eq(orders.locationId, op.locationId),
          ),
        )
        .limit(1);
      const order = orderRows[0];
      if (!order) return null;

      const items = await db
        .select({
          id: orderItems.id,
          product_id: orderItems.productId,
          variant_id: orderItems.variantId,
          name: orderItems.name,
          variant_name: orderItems.variantName,
          quantity: orderItems.quantity,
          price: orderItems.price,
          total: orderItems.total,
          line_discount: orderItems.lineDiscount,
          tax_amount: orderItems.taxAmount,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      // Everything already returned on this sale, per line.
      const priorRows = items.length
        ? await db
            .select({
              order_item_id: orderReturnItems.orderItemId,
              qty: sql<number>`sum(${orderReturnItems.quantity})`,
            })
            .from(orderReturnItems)
            .where(
              inArray(
                orderReturnItems.orderItemId,
                items.map((i) => i.id),
              ),
            )
            .groupBy(orderReturnItems.orderItemId)
        : [];

      return { order, items, priorRows };
    });

    if (!data) return { error: "That sale isn't from this shop." };
    const { order, items, priorRows } = data;
    const prior = new Map(
      priorRows.map((p) => [p.order_item_id, Number(p.qty) || 0]),
    );

    // orders.discount holds line markdowns AND the order-level discount; the
    // markdowns are already inside each line's total, so only the remainder is
    // the order-level part to re-allocate.
    const lineDiscounts = items.reduce(
      (a, i) => a + (Number(i.line_discount) || 0),
      0,
    );
    const orderDiscount = Math.max(
      0,
      (Number(order.discount) || 0) - lineDiscounts,
    );

    return {
      sale: {
        orderId: order.id,
        receiptNo: order.receipt_no ?? "",
        orderRef: order.order_ref ?? "",
        createdAt: order.created_at,
        total: Number(order.total) || 0,
        orderDiscount,
        paymentMethod: order.payment_method ?? "",
        lines: items.map((i) => {
          const returned = prior.get(i.id) ?? 0;
          return {
            id: i.id,
            productId: i.product_id,
            variantId: i.variant_id,
            name: i.name,
            variantName: i.variant_name,
            quantity: Number(i.quantity) || 0,
            returned,
            remaining: remainingQty({
              id: i.id,
              quantity: Number(i.quantity) || 0,
              lineTotal: Number(i.total) || 0,
              taxAmount: Number(i.tax_amount) || 0,
              alreadyReturned: returned,
            }),
            unitPrice: Number(i.price) || 0,
            lineTotal: Number(i.total) || 0,
            taxAmount: Number(i.tax_amount) || 0,
          };
        }),
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't load that sale.") };
  }
}

export interface ReturnLineInput {
  orderItemId: string;
  quantity: number;
  condition?: ReturnCondition;
}

export interface ReturnResult {
  returnId?: string;
  refunded?: number;
  error?: string;
}

/**
 * Take goods back and hand the money over.
 *
 * The amount is never taken from the client: it is recomputed with
 * `refundBreakdown` from the sale's stored snapshot, so a tampered request can
 * change WHAT comes back but not what it is worth.
 */
export async function processReturn(
  orderId: string,
  lines: ReturnLineInput[],
  method: RefundMethod,
  reason?: string,
): Promise<ReturnResult> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "refund")) {
    return { error: "You don't have permission to take returns." };
  }
  if (!REFUND_METHODS.includes(method)) {
    return { error: "Choose how the money goes back." };
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return { error: "Choose what's coming back." };
  }

  const { sale, error } = await getReturnableSale(orderId);
  if (error || !sale)
    return { error: error ?? "That sale isn't from this shop." };

  const returnable: ReturnableLine[] = sale.lines.map((l) => ({
    id: l.id,
    quantity: l.quantity,
    lineTotal: l.lineTotal,
    taxAmount: l.taxAmount,
    alreadyReturned: l.returned,
  }));

  const breakdown = refundBreakdown({
    lines: returnable,
    orderDiscount: sale.orderDiscount,
    request: lines.map((l) => ({ id: l.orderItemId, quantity: l.quantity })),
  });

  if (breakdown.lines.length === 0 || breakdown.total <= 0) {
    return { error: "Nothing on this sale is still returnable." };
  }

  const conditionOf = new Map(
    lines.map((l) => [
      l.orderItemId,
      l.condition === "damaged" ? "damaged" : "sellable",
    ]),
  );
  const lineById = new Map(sale.lines.map((l) => [l.id, l]));
  const shiftId = await currentShiftIdFor(op.locationId);

  let returnId: string;
  try {
    returnId = await withService(async (db) => {
      const inserted = await db
        .insert(orderReturns)
        .values({
          storeId: op.storeId,
          orderId,
          locationId: op.locationId,
          shiftId: shiftId ?? null,
          amount: breakdown.amount,
          tax: breakdown.tax,
          total: breakdown.total,
          reason: reason?.trim().slice(0, 200) || null,
          actor: op.staffId ?? op.name,
        })
        .returning({ id: orderReturns.id });
      const id = inserted[0]!.id;

      await db.insert(orderReturnItems).values(
        breakdown.lines.map((l) => ({
          returnId: id,
          orderItemId: l.id,
          quantity: l.quantity,
          amount: l.amount,
          tax: l.tax,
          total: l.total,
          condition: conditionOf.get(l.id) ?? "sellable",
          // Set truthfully below — the stock write can fail independently.
          restocked: false,
        })),
      );

      await db.insert(orderRefunds).values({
        storeId: op.storeId,
        orderId,
        returnId: id,
        locationId: op.locationId,
        shiftId: shiftId ?? null,
        method,
        amount: breakdown.total,
        status: "completed",
        actor: op.staffId ?? op.name,
      });

      return id;
    });
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't record the return.") };
  }

  // Put the sellable units back. AFTER the records, deliberately: the money is
  // already across the counter by this point, so a stock write that fails must
  // not undo a refund that physically happened. A missed restock shows up in
  // the next count; an unrecorded refund never shows up at all.
  const restocked: string[] = [];
  for (const l of breakdown.lines) {
    if ((conditionOf.get(l.id) ?? "sellable") !== "sellable") continue;
    const src = lineById.get(l.id);
    if (!src?.productId) continue;
    try {
      await withService((db) =>
        db.execute(
          sql`select adjust_stock_at(p_store => ${op.storeId}, p_location => ${op.locationId}, p_product => ${src.productId}, p_variant => ${src.variantId || null}, p_delta => ${l.quantity}, p_reason => ${"return"}, p_note => ${`Return on ${sale.receiptNo}`}, p_actor => ${op.staffId ?? op.name}) as new_stock`,
        ),
      );
      restocked.push(l.id);
    } catch (err) {
      console.error("processReturn restock:", l.id, err);
    }
  }

  if (restocked.length > 0) {
    await withService((db) =>
      db
        .update(orderReturnItems)
        .set({ restocked: true })
        .where(
          and(
            eq(orderReturnItems.returnId, returnId),
            inArray(orderReturnItems.orderItemId, restocked),
          ),
        ),
    ).catch((err) => console.error("processReturn restock flag:", err));

    // Coming back on the shelf can cross a low-stock threshold in reverse —
    // the same reporting a sale does, with a positive delta.
    reportStockChanges(
      op.storeId,
      breakdown.lines
        .filter((l) => restocked.includes(l.id))
        .map((l) => ({
          productId: lineById.get(l.id)!.productId!,
          variantId: lineById.get(l.id)!.variantId,
          delta: l.quantity,
        })),
    );
  }

  // Fully returned ⇒ the sale is refunded. Partially ⇒ leave it alone: it is
  // still a completed sale for the part the customer kept.
  const allBack = sale.lines.every(
    (l) =>
      l.remaining === 0 ||
      breakdown.lines.find((b) => b.id === l.id)?.quantity === l.remaining,
  );
  if (allBack) {
    await withService((db) =>
      db
        .update(orders)
        .set({ status: "refunded", paymentStatus: "refunded" })
        .where(and(eq(orders.id, orderId), eq(orders.storeId, op.storeId))),
    ).catch((err) => console.error("processReturn status:", err));
  }

  emitEvent({
    type: "order.refund_issued",
    storeId: op.storeId,
    locationId: op.locationId,
    actor: { type: "admin", id: op.staffId ?? null, label: op.name },
    subject: { type: "order", id: orderId, label: sale.receiptNo },
    payload: {
      total: breakdown.total,
      currency: "INR",
      paymentMethod: method,
      items: breakdown.lines.reduce((a, l) => a + l.quantity, 0),
    },
  });

  revalidatePath("/pos/sales");
  return { returnId, refunded: breakdown.total };
}
