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

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
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
import { storeLocations, stores } from "@/drizzle/schema";
import {
  locationCan,
  normalizeCapabilities,
  type LocationType,
} from "@/lib/locations/capabilities";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { effectivePlan } from "@/lib/plans";
import {
  canTakeReturnHere,
  isTenderAllowed,
  refundRouteFor,
  type RefundRoute,
} from "@/lib/returns/in-store";
import { issueRefund } from "@/lib/payments/issue-refund";
import { refundableAmount } from "@/lib/payments/refunds";
import { logError } from "@/lib/observability/logger";
import { OPEN_RETURN_STATUSES } from "@/lib/returns/lifecycle";

/** Tenders a shop can hand money back through at the counter. */
// What a counter can hand money back through, PLUS the gateway — which the
// operator never chooses (refundRouteFor decides it from the tender) but which
// processReturn must accept when that is where the money has to go.
const REFUND_METHODS = ["cash", "card", "upi", "razorpay"] as const;
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
  /** TRUE when this order was NOT rung at this counter — an online order, or
   *  one sold at another shop (BORIS, roadmap Step 5). */
  broughtIn: boolean;
  /** Where the money must go, and whether the counter gets a say. Computed
   *  server-side from the TENDER, never offered as a preference. */
  refundRoute: RefundRoute;
}

export interface FoundOrder {
  orderId: string;
  label: string;
  createdAt: string | null;
  total: number;
  paymentMethod: string;
  /** Not rung at this counter — needs the BORIS gates. */
  broughtIn: boolean;
}

/**
 * Find an order to take back, from whatever the customer walked in with.
 *
 * ★ STORE-scoped, deliberately NOT location-scoped. Someone returning an
 * online order has an order number or a phone, not a receipt from this shop,
 * and the whole point of BORIS is that they didn't buy it here. Whether this
 * counter may ACCEPT it is a separate question, answered by getReturnableSale
 * — showing them the order and then refusing is a better experience than
 * pretending it doesn't exist.
 */
export async function findOrderForReturn(
  query: string,
): Promise<{ results: FoundOrder[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { results: [], error: "Not signed in." };
  if (!posCan(op.role, "refund")) {
    return { results: [], error: "You don't have permission to take returns." };
  }

  const q = typeof query === "string" ? query.trim() : "";
  // Two characters matches half the shop. Order refs and phone numbers are
  // both long, so a real lookup always clears this.
  if (q.length < 4) return { results: [] };
  const like = `%${q}%`;

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          receipt_no: orders.receiptNo,
          created_at: orders.createdAt,
          total: orders.total,
          payment_method: orders.paymentMethod,
          location_id: orders.locationId,
        })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, op.storeId),
            // Nothing already cancelled or fully refunded — there is nothing
            // left to hand back.
            inArray(orders.status, [
              "processing",
              "shipped",
              "delivered",
              "completed",
            ]),
            or(
              ilike(orders.orderRef, like),
              ilike(orders.receiptNo, like),
              // The shopper's phone, from the address they gave. Cast because
              // shipping_address is jsonb.
              sql`${orders.shippingAddress}->>'phone' ilike ${like}`,
              sql`${orders.shippingAddress}->>'email' ilike ${like}`,
            ),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(20),
    );

    return {
      results: rows.map((r) => ({
        orderId: r.id,
        label: r.order_ref ?? r.receipt_no ?? r.id.slice(0, 8),
        createdAt: r.created_at,
        total: Number(r.total ?? 0),
        paymentMethod: r.payment_method ?? "",
        broughtIn: r.location_id !== op.locationId,
      })),
    };
  } catch (err) {
    logError("pos.return_search", err);
    return { results: [], error: "Couldn't search orders." };
  }
}

/**
 * The two store-side gates BORIS needs: the `returns.allowInStore` setting and
 * this location's `returns` capability.
 *
 * Read together in one place so the answer can't drift between the lookup and
 * the write. Fails CLOSED on an error — refusing a return the merchant can
 * still take by hand is recoverable; accepting one at a counter that isn't set
 * up for it puts stock on the wrong shelf and money out of the wrong drawer.
 */
async function borisGates(
  storeId: string,
  locationId: string,
): Promise<{ storeAllows: boolean; locationAccepts: boolean }> {
  try {
    const [storeRow, locRow] = await withService(async (db) => {
      const st = await db
        .select({
          settings: stores.settings,
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const loc = await db
        .select({
          capabilities: storeLocations.capabilities,
          type: storeLocations.type,
        })
        .from(storeLocations)
        .where(eq(storeLocations.id, locationId))
        .limit(1);
      return [st[0], loc[0]] as const;
    });
    if (!storeRow || !locRow) {
      return { storeAllows: false, locationAccepts: false };
    }

    const plan = effectivePlan({
      plan: storeRow.plan,
      plan_expires_at: storeRow.plan_expires_at,
    });
    const settings = resolveStoreSettings(
      storeRow.settings as Record<string, unknown> | null,
      plan,
    );
    const caps = normalizeCapabilities(
      locRow.capabilities,
      locRow.type as LocationType,
    );

    return {
      storeAllows:
        settings["returns.enabled"] === true &&
        settings["returns.allowInStore"] === true,
      locationAccepts: locationCan(caps, "returns", { plan }),
    };
  } catch (err) {
    // Fails CLOSED, so this log is the only trace: the counter simply reports
    // that it can't take the return, and nothing says why.
    logError("pos.boris_gates", err, { storeId, locationId });
    return { storeAllows: false, locationAccepts: false };
  }
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
          payment_status: orders.paymentStatus,
          location_id: orders.locationId,
          sales_channel: orders.salesChannel,
        })
        .from(orders)
        // ★ STORE-scoped, not location-scoped (roadmap Step 5). The old
        // `location_id = op.locationId` predicate could never find an ONLINE
        // order — its location is the FULFILMENT one, or null — so BORIS
        // found nothing at all. The location question doesn't disappear; it
        // splits in two, and `canTakeHere` below answers the permission half
        // while the stock half stays "the shop they walked into".
        .where(and(eq(orders.id, orderId), eq(orders.storeId, op.storeId)))
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

    // ── May this counter take it? ────────────────────────────────────────
    // A sale rung HERE is always returnable here (invariant 1 — the till has
    // done this since pos_12). Anything else is BORIS, and needs both the
    // store switch and this location's `returns` capability.
    const broughtIn = order.location_id !== op.locationId;
    if (broughtIn) {
      const verdict = canTakeReturnHere({
        soldHere: false,
        ...(await borisGates(op.storeId, op.locationId)),
      });
      if (!verdict.allowed) return { error: verdict.reason };
    }

    return {
      sale: {
        orderId: order.id,
        broughtIn,
        refundRoute: refundRouteFor({
          paymentMethod: order.payment_method,
          paymentStatus: order.payment_status,
        }),
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
  /** The goods came back but the money needs a word — a gateway refund that
   *  failed or hasn't confirmed. NOT an error: the return stands. */
  note?: string;
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

  // getReturnableSale re-runs the BORIS gates, so a counter that may not take
  // this order can't reach the write by calling processReturn directly.
  const { sale, error } = await getReturnableSale(orderId);
  if (error || !sale)
    return { error: error ?? "That sale isn't from this shop." };

  // ★ THE TENDER DECIDES WHERE THE MONEY GOES — the till hides the wrong
  // options, and this is the server refusing them anyway. Handing cash back
  // for a card sale is the card-not-present laundering path.
  const route = sale.refundRoute;
  if (!isTenderAllowed(route, method)) {
    return {
      error: route.counterChoice
        ? "Choose how the money goes back."
        : "This order was paid online, so the refund has to go back the same way.",
    };
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
  let breakdown: ReturnType<typeof refundBreakdown>;
  try {
    const written = await withService(async (db) => {
      // ★ LOCK THE ORDER, THEN RE-READ WHAT IS LEFT.
      //
      // `getReturnableSale` above answered "what may come back" a moment ago,
      // outside any transaction. Two counters serving the same customer — or
      // one cashier double-tapping Confirm — both read that answer before
      // either wrote, and both then handed over the full value: proven on
      // staging as ₹158 refunded against a ₹79 sale. The gateway path was
      // safe because issueRefund takes this same lock; the CASH path wrote
      // its refund row directly and was not protected by anything.
      const locked = await db
        .select({
          id: orders.id,
          total: orders.total,
          discount: orders.discount,
          store_credit_used: orders.storeCreditUsed,
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.storeId, op.storeId)))
        .limit(1)
        .for("update");
      if (!locked.length) return { error: "That sale isn't from this shop." };

      const items = await db
        .select({
          id: orderItems.id,
          quantity: orderItems.quantity,
          total: orderItems.total,
          line_discount: orderItems.lineDiscount,
          tax_amount: orderItems.taxAmount,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      // Only OPEN returns hold units. Without the status filter a REJECTED
      // online request would keep blocking the counter, so a customer turned
      // down online could not bring the goods in either.
      const prior = items.length
        ? await db
            .select({
              order_item_id: orderReturnItems.orderItemId,
              qty: sql<number>`sum(${orderReturnItems.quantity})::int`,
            })
            .from(orderReturnItems)
            .innerJoin(
              orderReturns,
              eq(orderReturns.id, orderReturnItems.returnId),
            )
            .where(
              and(
                inArray(
                  orderReturnItems.orderItemId,
                  items.map((i) => i.id),
                ),
                inArray(orderReturns.status, OPEN_RETURN_STATUSES),
              ),
            )
            .groupBy(orderReturnItems.orderItemId)
        : [];
      const returnedBy = new Map(
        prior.map((p) => [p.order_item_id, Number(p.qty) || 0]),
      );

      const lineDiscounts = items.reduce(
        (a, i) => a + (Number(i.line_discount) || 0),
        0,
      );
      const returnable: ReturnableLine[] = items.map((i) => ({
        id: i.id,
        quantity: Number(i.quantity) || 0,
        lineTotal: Number(i.total) || 0,
        taxAmount: Number(i.tax_amount) || 0,
        alreadyReturned: returnedBy.get(i.id) ?? 0,
      }));

      const priced = refundBreakdown({
        lines: returnable,
        orderDiscount: Math.max(
          0,
          (Number(locked[0]!.discount) || 0) - lineDiscounts,
        ),
        request: lines.map((l) => ({
          id: l.orderItemId,
          quantity: l.quantity,
        })),
      });
      if (priced.lines.length === 0 || priced.total <= 0) {
        return { error: "Nothing on this sale is still returnable." };
      }

      // ★ AND CAP IT AGAINST WHAT THE ORDER CAN STILL GIVE BACK. The quantity
      // clamp above bounds the GOODS; this bounds the MONEY, which is the
      // thing leaving the drawer. issueRefund does exactly this for the
      // gateway; the counter tenders had no equivalent at all.
      if (method !== "razorpay") {
        const existing = await db
          .select({
            amount: orderRefunds.amount,
            status: orderRefunds.status,
            method: orderRefunds.method,
          })
          .from(orderRefunds)
          .where(eq(orderRefunds.orderId, orderId));
        const cap = refundableAmount({
          orderTotal: Number(locked[0]!.total ?? 0),
          refunds: existing.map((r) => ({
            amount: Number(r.amount ?? 0),
            status: r.status,
            method: r.method,
          })),
          storeCreditUsed: Number(locked[0]!.store_credit_used ?? 0),
          method,
        });
        if (priced.total > cap) {
          return {
            error:
              cap > 0
                ? `You can refund at most ₹${cap.toFixed(2)} on this sale.`
                : "This sale has already been fully refunded.",
          };
        }
      }

      const inserted = await db
        .insert(orderReturns)
        .values({
          storeId: op.storeId,
          orderId,
          locationId: op.locationId,
          shiftId: shiftId ?? null,
          amount: priced.amount,
          tax: priced.tax,
          total: priced.total,
          reason: reason?.trim().slice(0, 200) || null,
          actor: op.staffId ?? op.name,
        })
        .returning({ id: orderReturns.id });
      const id = inserted[0]!.id;

      await db.insert(orderReturnItems).values(
        priced.lines.map((l) => ({
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

      // ★ A COUNTER refund is recorded here, inside the same transaction as
      // the goods — the money is already across the counter, so the row must
      // not be able to exist without the return, or vice versa.
      //
      // A GATEWAY refund is NOT written here: it has to call Razorpay, which
      // cannot happen inside a transaction, and it is issued below through the
      // shared lib/payments/issue-refund.ts so the till inherits the
      // pending-row-first idempotency rather than reimplementing it.
      if (method !== "razorpay") {
        await db.insert(orderRefunds).values({
          storeId: op.storeId,
          orderId,
          returnId: id,
          locationId: op.locationId,
          shiftId: shiftId ?? null,
          method,
          amount: priced.total,
          status: "completed",
          actor: op.staffId ?? op.name,
        });
      }

      return { id, priced };
    });
    if ("error" in written) return { error: written.error };
    returnId = written.id;
    breakdown = written.priced;
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
      // ★ The money has ALREADY crossed the counter by this point, so this
      // can't be undone — the goods are back on the shelf and the count is
      // wrong until someone notices. Exactly the silent failure that belongs
      // in Error Reporting rather than a console line nobody reads.
      logError("pos.return_restock", err, { returnId, orderItemId: l.id });
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
    ).catch((err) => logError("pos.return_restock_flag", err, { returnId }));

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

  // ── Gateway refunds go out through the shared core ──────────────────────
  // The goods are already booked in. If the gateway call fails, the RETURN
  // still stands (the customer handed the items over and is walking away with
  // nothing) — the merchant is told and can retry from the order. Unwinding
  // the receipt instead would lose a restock that physically happened.
  let gatewayNote: string | undefined;
  if (method === "razorpay") {
    const res = await issueRefund({
      storeId: op.storeId,
      orderId,
      amount: breakdown.total,
      method: "razorpay",
      actor: op.staffId ?? op.name,
      reason: reason?.trim().slice(0, 200) || "Returned in store",
      returnId,
      // ★ Deliberately NO locationId/shiftId: a gateway refund never touches
      // the drawer, and stamping a shift would make the cash report count
      // money that never left the till.
    });
    if (res.error) {
      gatewayNote =
        res.code === "gateway_not_connected"
          ? "Items taken back, but the card refund couldn't be sent — ask the owner to refund it from the dashboard."
          : `Items taken back, but the refund failed: ${res.error}`;
    } else if (res.pendingReconcile) {
      gatewayNote =
        "Items taken back. The refund is with the bank and hasn't confirmed yet — don't send it again.";
    }
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
    ).catch((err) => logError("pos.return_order_status", err, { orderId }));
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
  return { returnId, refunded: breakdown.total, note: gatewayNote };
}
