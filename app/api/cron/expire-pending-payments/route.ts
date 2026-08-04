import { NextResponse } from "next/server";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { recordEvent } from "@/lib/notifications/record";
import { orderItems, orders } from "@/drizzle/schema";
import { getStoreGateway } from "@/lib/payments/provider";
import { sweepExpiredHolds } from "@/lib/inventory/reservations";
import {
  sweepExpiredPickups,
  sweepPickupReminders,
} from "@/lib/fulfilment/pickup";
import {
  capturedPayment,
  rzpFetchOrderPayments,
} from "@/lib/payments/razorpay";
import { sweepPendingRefunds } from "@/lib/payments/refund-reconcile";

// Reaper for online-payment orders stuck in `payment_status: 'pending'` —
// v1 has no merchant webhooks (reconcile-on-read instead), so this scheduled
// job is the safety net for shoppers who paid but never triggered
// confirmOnlinePayment, and for orders whose payment simply never happened.
// It runs DAILY on the Vercel Hobby plan (which caps crons at once/day); it's
// only a backstop, since the success page reconciles a real payment instantly.
// On Vercel Pro, bump the vercel.json schedule back to hourly.
//
// For each razorpay order pending longer than the grace window:
//   1. Ask Razorpay first — a CAPTURED payment means the money was taken:
//      mark the order paid (never lose a paid order).
//   2. Otherwise atomically claim the pending → failed transition, then
//      release the reserved stock (the existing reserved → released
//      conditional claim, exactly-once), release the coupon use, and cancel
//      the order.
//
// It ALSO cancels pickups nobody collected (Phase F) and sweeps expired stock
// holds (roadmap Phase E). Same job because it is
// the same shape of problem — units set aside for something that never
// completed — and a hold nobody ends would make stock unsellable forever.
// Independent of the payment work below: the sweep runs even when there are no
// pending orders, and a failure in one must not skip the other.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it).

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Long enough for a slow UPI approve + the shopper's retry attempts; short
// enough that reserved stock isn't hostage for hours.
const GRACE_MINUTES = 45;
const BATCH_LIMIT = 200;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// placeOrder stores the coupon code as typed; the usage counters key on the
// normalized form (mirror of checkout-actions normalizeCode).
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

interface PendingOrder {
  id: string;
  store_id: string;
  razorpay_order_id: string | null;
  applied_coupon_code: string | null;
  order_ref: string | null;
  customer_id: string | null;
  total: number | null;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString();

  let pending: PendingOrder[];
  try {
    pending = await withService((db) =>
      db
        .select({
          id: orders.id,
          store_id: orders.storeId,
          razorpay_order_id: orders.razorpayOrderId,
          applied_coupon_code: orders.appliedCouponCode,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          total: orders.total,
        })
        .from(orders)
        .where(
          and(
            eq(orders.paymentMethod, "razorpay"),
            eq(orders.paymentStatus, "pending"),
            lte(orders.createdAt, cutoff),
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(BATCH_LIMIT),
    );
  } catch (err) {
    console.error(
      "expire-pending-payments (read):",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "read failed" }, { status: 500 });
  }
  if (!pending.length) {
    // The refund sweep runs even with no pending payments — money going OUT
    // is a different queue from money coming in, and a store can easily have
    // a refund in limbo and not one unpaid order.
    return NextResponse.json({
      ok: true,
      paid: 0,
      expired: 0,
      refundsSettled: await sweepPendingRefunds(),
      holdsFreed: await sweepExpiredHolds(),
    });
  }

  // One gateway lookup (and decrypt) per store, not per order.
  const gateways = new Map<
    string,
    Awaited<ReturnType<typeof getStoreGateway>>
  >();
  const gatewayFor = async (storeId: string) => {
    if (!gateways.has(storeId)) {
      gateways.set(storeId, await getStoreGateway(storeId));
    }
    return gateways.get(storeId) ?? null;
  };

  let paid = 0;
  let expired = 0;

  for (const order of pending) {
    // 1. Razorpay is the source of truth — never cancel a paid order.
    if (order.razorpay_order_id) {
      const gateway = await gatewayFor(order.store_id);
      if (gateway) {
        const res = await rzpFetchOrderPayments(
          gateway.creds,
          order.razorpay_order_id,
        );
        if (!res.ok) {
          // Can't reach Razorpay for this order — skip it this run rather
          // than risk cancelling a captured payment.
          console.error(
            `expire-pending-payments (rzp fetch, order ${order.id}):`,
            res.error,
          );
          continue;
        }
        const captured = capturedPayment(res.data);
        if (captured) {
          try {
            await withService((db) =>
              db
                .update(orders)
                .set({
                  paymentStatus: "paid",
                  razorpayPaymentId: captured.id,
                })
                .where(
                  and(
                    eq(orders.id, order.id),
                    eq(orders.paymentStatus, "pending"),
                  ),
                ),
            );
            paid++;
          } catch (err) {
            console.error(
              `expire-pending-payments (mark paid, order ${order.id}):`,
              err instanceof Error ? err.message : err,
            );
          }
          continue;
        }
      }
      // Gateway disconnected since the order was placed → nothing captured is
      // verifiable; fall through and expire it (stock shouldn't stay hostage).
    }

    // 2. Claim the pending → failed transition atomically. A shopper's
    //    confirmOnlinePayment racing this loop flips pending → paid first and
    //    this claim then matches nothing — the order is left alone.
    let claimed: { id: string }[];
    try {
      claimed = await withService((db) =>
        db
          .update(orders)
          .set({ paymentStatus: "failed", status: "cancelled" })
          .where(
            and(eq(orders.id, order.id), eq(orders.paymentStatus, "pending")),
          )
          .returning({ id: orders.id }),
      );
    } catch (claimErr) {
      console.error(
        `expire-pending-payments (claim, order ${order.id}):`,
        claimErr instanceof Error ? claimErr.message : claimErr,
      );
      continue;
    }
    if (!claimed.length) continue;
    expired++;

    // The merchant needs to know an order died unpaid — it looked like a sale
    // in the dashboard until this ran. recordEvent (not emitEvent): a cron
    // response ends the moment we return, so after() has nothing to run on.
    await recordEvent({
      type: "order.payment_failed",
      storeId: order.store_id,
      actor: { type: "system" },
      subject: { type: "order", id: order.id, label: order.order_ref },
      customerId: order.customer_id,
      payload: {
        orderRef: order.order_ref ?? "",
        total: Number(order.total ?? 0),
        currency: "INR",
        reason: "Payment not completed",
      },
    });

    // 3. Restock exactly once (the order-actions cancellation pattern).
    const stockClaim = await withService((db) =>
      db
        .update(orders)
        .set({ stockStatus: "released" })
        .where(and(eq(orders.id, order.id), eq(orders.stockStatus, "reserved")))
        .returning({ id: orders.id }),
    ).catch(() => []);
    if (stockClaim.length) {
      const items = await withService((db) =>
        db
          .select({
            product_id: orderItems.productId,
            variant_id: orderItems.variantId,
            quantity: orderItems.quantity,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id)),
      ).catch(() => []);
      for (const item of items) {
        await withService((db) =>
          db.execute(
            sql`select release_stock(p_store => ${order.store_id}, p_product => ${item.product_id}, p_variant => ${item.variant_id}, p_qty => ${item.quantity}, p_order => ${order.id}, p_reason => ${"payment_expired"})`,
          ),
        ).catch((err) =>
          console.error(
            `expire-pending-payments (release_stock, order ${order.id}):`,
            err instanceof Error ? err.message : err,
          ),
        );
      }
    }

    // 4. Give the coupon use back (best-effort, floors at 0).
    if (order.applied_coupon_code) {
      await withService((db) =>
        db.execute(
          sql`select decrement_coupon_usage(p_code => ${normalizeCode(order.applied_coupon_code!)}, p_store_id => ${order.store_id})`,
        ),
      ).catch((err) =>
        console.error(
          `expire-pending-payments (decrement_coupon, order ${order.id}):`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
  }

  // Pickups first: cancelling an uncollected order releases its own holds, so
  // running the generic sweep afterwards finds a tidier table (and anything the
  // pickup pass failed to release still lapses here on TTL).
  const pickupsExpired = await sweepExpiredPickups();
  // Reminders AFTER the expiry sweep, never before: an order that just lapsed
  // is no longer awaiting collection, and telling someone to hurry and collect
  // something we have already cancelled is worse than saying nothing.
  const pickupsWarned = await sweepPickupReminders();

  return NextResponse.json({
    ok: true,
    paid,
    expired,
    pickupsExpired,
    pickupsWarned,
    // Refunds whose gateway call we never got an answer for. The order page
    // reconciles instantly when anyone looks; this is the backstop for the
    // ones nobody opens.
    refundsSettled: await sweepPendingRefunds(),
    holdsFreed: await sweepExpiredHolds(),
  });
}

export const GET = handle;
export const POST = handle;
