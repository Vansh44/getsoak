import "server-only";

// Settling refunds whose outcome we never learned (roadmap Step 2,
// docs/returns-exchanges-plan.md §3.2 step 4).
//
// ── Why this exists ────────────────────────────────────────────────────────
// `refundOrder` writes its row BEFORE calling Razorpay, so a timeout leaves a
// `pending` row and no gateway id. That is the correct outcome — the
// alternative is deciding, with no information, whether a customer was paid —
// but it is only correct if something later finds out. This is that something.
//
// Two callers, one core:
//   • reconcile-on-read, when anyone opens the order (instant in practice), and
//   • the daily cron, for orders nobody looks at.
// This is the §18 decision unchanged: asking Razorpay when someone looks is
// cheaper than a webhook endpoint to secure.
//
// ── Never throws ───────────────────────────────────────────────────────────
// Every caller is doing something else that must not fail because a gateway
// was slow — rendering an order page, or sweeping pickups in the same cron.

import { and, asc, eq, lte, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orderRefunds, orders } from "@/drizzle/schema";
import { getStoreGateway } from "@/lib/payments/provider";
import {
  rzpFetchOrderPayments,
  rzpFetchPaymentRefunds,
  capturedPayment,
} from "@/lib/payments/razorpay";
import {
  mapGatewayRefundStatus,
  matchGatewayRefund,
  refundableAmount,
  toPaise,
} from "@/lib/payments/refunds";
import { logError } from "@/lib/observability/logger";

/** A refund is only chased once it has had a fair chance to settle. Razorpay
 *  usually answers in seconds; this is about calls we never heard back from. */
const SETTLE_GRACE_MS = 2 * 60_000;

interface PendingRow {
  id: string;
  store_id: string;
  order_id: string;
  amount: number;
  idempotency_key: string | null;
  created_at: string | null;
  razorpay_payment_id: string | null;
  razorpay_order_id: string | null;
}

async function loadPending(where: {
  orderId?: string;
  limit: number;
}): Promise<PendingRow[]> {
  const cutoff = new Date(Date.now() - SETTLE_GRACE_MS).toISOString();
  return withService((db) =>
    db
      .select({
        id: orderRefunds.id,
        store_id: orderRefunds.storeId,
        order_id: orderRefunds.orderId,
        amount: orderRefunds.amount,
        idempotency_key: orderRefunds.idempotencyKey,
        created_at: orderRefunds.createdAt,
        razorpay_payment_id: orders.razorpayPaymentId,
        razorpay_order_id: orders.razorpayOrderId,
      })
      .from(orderRefunds)
      .innerJoin(orders, eq(orders.id, orderRefunds.orderId))
      .where(
        and(
          eq(orderRefunds.status, "pending"),
          eq(orderRefunds.method, "razorpay"),
          lte(orderRefunds.createdAt, cutoff),
          ...(where.orderId ? [eq(orderRefunds.orderId, where.orderId)] : []),
        ),
      )
      .orderBy(asc(orderRefunds.createdAt))
      .limit(where.limit),
  );
}

/**
 * Settle one pending row against the gateway.
 *
 * Returns whether anything changed. A row we still can't resolve is LEFT
 * pending — that is the whole point; guessing is what this module exists to
 * avoid.
 */
async function settle(row: PendingRow): Promise<boolean> {
  const gateway = await getStoreGateway(row.store_id);
  if (!gateway) return false;

  // The payment id is normally stamped at confirm time, but an order that was
  // reconciled rather than confirmed may not carry one yet.
  let paymentId = row.razorpay_payment_id;
  if (!paymentId && row.razorpay_order_id) {
    const payments = await rzpFetchOrderPayments(
      gateway.creds,
      row.razorpay_order_id,
    );
    if (!payments.ok) return false;
    paymentId = capturedPayment(payments.data)?.id ?? null;
  }
  if (!paymentId) return false;

  const list = await rzpFetchPaymentRefunds(gateway.creds, paymentId);
  if (!list.ok) return false;

  const mine = row.idempotency_key
    ? matchGatewayRefund(list.data, row.idempotency_key)
    : null;

  if (!mine) {
    // Razorpay has no refund carrying our key. Two readings, and only one is
    // safe to act on: either the create never landed, or it landed and their
    // list is lagging. We take the first ONLY after the grace window has
    // passed several times over — until then the row stays pending, because
    // failing it would free the amount for a second refund of money that may
    // already be on its way back to the customer.
    const age = Date.now() - new Date(row.created_at ?? Date.now()).getTime();
    if (age < SETTLE_GRACE_MS * 15) return false;

    const claimed = await withService((db) =>
      db
        .update(orderRefunds)
        .set({
          status: "failed",
          reason: sql`coalesce(${orderRefunds.reason}, 'Never reached the gateway')`,
        })
        .where(
          and(eq(orderRefunds.id, row.id), eq(orderRefunds.status, "pending")),
        )
        .returning({ id: orderRefunds.id }),
    );
    return claimed.length > 0;
  }

  const status = mapGatewayRefundStatus(mine.status);
  if (status === "pending") return false;

  // Claim the transition conditionally, like every other exactly-once path
  // here: a concurrent reconcile-on-read and cron run can't both settle it.
  const claimed = await withService((db) =>
    db
      .update(orderRefunds)
      .set({ status, gatewayRefundId: mine.id })
      .where(
        and(eq(orderRefunds.id, row.id), eq(orderRefunds.status, "pending")),
      )
      .returning({ id: orderRefunds.id }),
  );
  if (!claimed.length) return false;

  if (status === "completed") await syncOrderRefundState(row.order_id);
  return true;
}

/**
 * Recompute `orders.payment_status` from the refunds that actually settled.
 *
 * Derived, never accumulated: a refund that later fails has to be able to move
 * the order back off "refunded", and a status incremented at each step can't
 * do that. Only `completed` rows count — this is the one place `pending`
 * deliberately does NOT, because here we are describing what has happened
 * rather than reserving headroom (see refundableAmount for the other side).
 */
export async function syncOrderRefundState(orderId: string): Promise<void> {
  try {
    await withService(async (db) => {
      const rows = await db
        .select({ total: orders.total, paid: orders.paymentStatus })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      const order = rows[0];
      if (!order) return;

      const settled = await db
        .select({ amount: orderRefunds.amount })
        .from(orderRefunds)
        .where(
          and(
            eq(orderRefunds.orderId, orderId),
            eq(orderRefunds.status, "completed"),
          ),
        );

      const refundedP = settled.reduce(
        (sum, r) => sum + Math.max(0, toPaise(r.amount)),
        0,
      );
      const totalP = Math.max(0, toPaise(order.total ?? 0));

      // Anything already refunded is at least partial; only a full one is
      // "refunded". An order with nothing settled goes back to `paid` — that
      // is what makes a failed refund reversible in the UI.
      const next =
        refundedP <= 0
          ? order.paid === "refunded" || order.paid === "partially_refunded"
            ? "paid"
            : order.paid
          : refundedP >= totalP
            ? "refunded"
            : "partially_refunded";

      if (next && next !== order.paid) {
        await db
          .update(orders)
          .set({ paymentStatus: next })
          .where(eq(orders.id, orderId));
      }
    });
  } catch (err) {
    logError("refund.sync_order_state", err, { orderId });
  }
}

/** Reconcile every pending refund on ONE order — the read path. */
export async function reconcileOrderRefunds(orderId: string): Promise<number> {
  try {
    const rows = await loadPending({ orderId, limit: 20 });
    let settled = 0;
    for (const row of rows) if (await settle(row)) settled++;
    return settled;
  } catch (err) {
    logError("refund.reconcile_order", err, { orderId });
    return 0;
  }
}

/** Reconcile pending refunds across all stores — the cron backstop. */
export async function sweepPendingRefunds(limit = 100): Promise<number> {
  try {
    const rows = await loadPending({ limit });
    let settled = 0;
    for (const row of rows) if (await settle(row)) settled++;
    return settled;
  } catch (err) {
    logError("refund.sweep", err);
    return 0;
  }
}

/**
 * Money this order still owes its customer — the number a cancellation has to
 * surface.
 *
 * Cancelling and expiring both leave a paid order with nothing shipped, and
 * the decision (returns-exchanges-plan §2.2) is that money NEVER leaves on a
 * schedule or without a human. So the obligation has to be visible instead:
 * this is what the order drawer escalates and what rides into the
 * `order.cancelled` / `order.pickup_expired` payloads, so a merchant learns
 * about it in the channel they already read.
 *
 * Zero for an unpaid order — there is nothing to give back — and zero on any
 * error, because inventing an obligation is worse than missing one.
 */
export async function refundDueForOrder(order: {
  id: string;
  total: number | null;
  paymentStatus: string | null;
}): Promise<number> {
  if (
    order.paymentStatus !== "paid" &&
    order.paymentStatus !== "partially_refunded"
  ) {
    return 0;
  }
  try {
    const rows = await withService((db) =>
      db
        .select({ amount: orderRefunds.amount, status: orderRefunds.status })
        .from(orderRefunds)
        .where(eq(orderRefunds.orderId, order.id)),
    );
    return refundableAmount({
      orderTotal: Number(order.total ?? 0),
      refunds: rows.map((r) => ({
        amount: Number(r.amount ?? 0),
        status: r.status,
      })),
    });
  } catch (err) {
    logError("refund.due_for_order", err, { orderId: order.id });
    return 0;
  }
}
