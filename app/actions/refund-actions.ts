"use server";

// Money out (roadmap Step 2, docs/returns-exchanges-plan.md §3).
//
// The mirror of placeOrder, and the same trust boundary: the caller is gated
// server-side, the order is re-read from the DB, the amount is RECOMPUTED
// against what remains refundable, and only then does anything move. The
// client says which order and how much — never what is allowed.
//
// ── The one thing that makes this different from every other action here ───
// A refund is the only call in the codebase where a RETRY is dangerous. A
// timeout is indistinguishable from a success we never read, so retrying
// blind pays the customer twice. Hence the order of operations below, which
// is the whole design and must not be "tidied":
//
//   1. write the refund row FIRST, `pending`, with a key WE generated
//   2. call Razorpay with that key (header + notes)
//   3. claim pending → completed|failed conditionally
//   4. an UNKNOWN outcome stays pending — lib/payments/refund-reconcile.ts
//      finds out later, from the gateway, rather than us guessing now
//
// Step 1 is what makes 4 possible: without a persisted key there is nothing to
// look the refund up BY, and reconciliation degenerates into matching on
// amount — which cannot tell two legitimate ₹500 refunds apart.
//
// ── What this does NOT do ──────────────────────────────────────────────────
// It does not restock. A refund and a return are different facts (a returned
// item may be damaged, and a cancellation has no goods at all) — roadmap
// invariant 8, and pos_12_returns.sql already keeps the two tables apart.

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import { orderRefunds, orders } from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerIdentity,
  isStoreSuperadmin,
} from "@/app/dashboard/lib/access";
import { getStoreSettings } from "@/lib/settings/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { getStoreGateway } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpFetchOrderPayments,
  rzpRefund,
} from "@/lib/payments/razorpay";
import {
  checkRefundAmount,
  DASHBOARD_REFUND_METHODS,
  refundableAmount,
  toPaise,
  type RefundStatus,
} from "@/lib/payments/refunds";
import {
  reconcileOrderRefunds,
  syncOrderRefundState,
} from "@/lib/payments/refund-reconcile";
import { logError } from "@/lib/observability/logger";

export type DashboardRefundMethod = (typeof DASHBOARD_REFUND_METHODS)[number];

export interface RefundRow {
  id: string;
  method: string;
  amount: number;
  status: string;
  reason: string | null;
  reference: string | null;
  gatewayRefundId: string | null;
  createdAt: string | null;
  actor: string | null;
}

export interface OrderRefundState {
  orderId: string;
  orderRef: string | null;
  total: number;
  paymentMethod: string | null;
  paymentStatus: string | null;
  /** How much can still go back. */
  refundable: number;
  /** ★ The order is dead but the money is still ours — a cancelled or expired
   *  order that was paid for. Nothing pays this automatically (§2.2), so the
   *  panel has to say so loudly; this flag is the "cancel prompts to refund"
   *  half of roadmap Step 2. Derived, so it clears itself once refunded. */
  refundOwed: boolean;
  /** Whether the gateway can do it, or the merchant must move the money. */
  canRefundOnline: boolean;
  /** Why not, when it can't — shown instead of a dead button. */
  onlineBlockedReason: string | null;
  refunds: RefundRow[];
}

/** Statuses where goods are never going to arrive, so money taken for them is
 *  owed back. `refunded` is absent on purpose — it is the settled end state. */
const DEAD_ORDER_STATUSES = ["cancelled"];

interface OrderForRefund {
  id: string;
  store_id: string;
  status: string | null;
  order_ref: string | null;
  customer_id: string | null;
  total: number;
  payment_method: string | null;
  payment_status: string | null;
  razorpay_payment_id: string | null;
  razorpay_order_id: string | null;
}

async function loadOrder(
  orderId: string,
  storeId: string,
): Promise<OrderForRefund | null> {
  const rows = await withService((db) =>
    db
      .select({
        id: orders.id,
        store_id: orders.storeId,
        order_ref: orders.orderRef,
        customer_id: orders.customerId,
        status: orders.status,
        total: orders.total,
        payment_method: orders.paymentMethod,
        payment_status: orders.paymentStatus,
        razorpay_payment_id: orders.razorpayPaymentId,
        razorpay_order_id: orders.razorpayOrderId,
      })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
      .limit(1),
  );
  const row = rows[0];
  return row ? { ...row, total: Number(row.total ?? 0) } : null;
}

async function loadRefunds(orderId: string): Promise<RefundRow[]> {
  const rows = await withService((db) =>
    db
      .select({
        id: orderRefunds.id,
        method: orderRefunds.method,
        amount: orderRefunds.amount,
        status: orderRefunds.status,
        reason: orderRefunds.reason,
        reference: orderRefunds.reference,
        gatewayRefundId: orderRefunds.gatewayRefundId,
        createdAt: orderRefunds.createdAt,
        actor: orderRefunds.actor,
      })
      .from(orderRefunds)
      .where(eq(orderRefunds.orderId, orderId))
      .orderBy(desc(orderRefunds.createdAt)),
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount ?? 0) }));
}

/**
 * Everything the refund panel needs, including WHY online is unavailable.
 *
 * Reconciles first: opening the order is the moment someone cares, and it is
 * the fast path that makes the daily cron a backstop rather than the only way
 * a stuck refund ever resolves (the §18 reconcile-on-read decision).
 */
export async function getOrderRefundState(
  orderId: string,
): Promise<{ state?: OrderRefundState; error?: string }> {
  const admin = await getManagerIdentity("orders");
  if (!admin) return { error: "Not authenticated" };
  if (typeof orderId !== "string" || !orderId.trim()) {
    return { error: "Invalid order." };
  }
  const storeId = await getActingStoreId();

  try {
    await reconcileOrderRefunds(orderId);

    const order = await loadOrder(orderId, storeId);
    if (!order) return { error: "Order not found." };
    const refunds = await loadRefunds(orderId);

    let canRefundOnline = false;
    let onlineBlockedReason: string | null = null;
    if (order.payment_method !== "razorpay") {
      // Not a failure — COD money never reached a gateway, so there is nothing
      // to send back through one. §3.3: the merchant moves it and records it.
      onlineBlockedReason =
        "This order was paid on delivery, so there's no online payment to reverse. Pay the customer back however you normally do, then record it here.";
    } else if (order.payment_status !== "paid") {
      onlineBlockedReason =
        "This order was never paid, so there's nothing to refund.";
    } else if (!(await getStoreGateway(storeId))?.creds.keyId) {
      onlineBlockedReason =
        "Your Razorpay account isn't connected. Reconnect it in Channels to refund online.";
    } else {
      canRefundOnline = true;
    }

    const refundable = refundableAmount({ orderTotal: order.total, refunds });

    return {
      state: {
        orderId: order.id,
        orderRef: order.order_ref,
        total: order.total,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        refundable,
        // Money taken for something that will never be delivered. Deliberately
        // derived from the order's own state rather than stored: a flag would
        // need clearing on refund, on reinstatement and on partial refund, and
        // the one that gets missed is the one that nags a merchant forever.
        refundOwed:
          refundable > 0 &&
          DEAD_ORDER_STATUSES.includes(order.status ?? "") &&
          (order.payment_status === "paid" ||
            order.payment_status === "partially_refunded"),
        canRefundOnline,
        onlineBlockedReason,
        refunds,
      },
    };
  } catch (err) {
    return {
      error: dbErrorMessage(err, "Couldn't load refunds for this order."),
    };
  }
}

export interface RefundInput {
  /** Omit to refund everything still refundable. */
  amount?: number;
  method: DashboardRefundMethod;
  reason?: string;
  /** Required for `manual` — the merchant's proof the money moved. */
  reference?: string;
}

export interface RefundResult {
  refundId?: string;
  status?: RefundStatus;
  amount?: number;
  /** Set when the gateway's answer never arrived — the refund is real and
   *  in flight, and the UI must NOT invite a retry. */
  pendingReconcile?: boolean;
  error?: string;
}

export async function refundOrder(
  orderId: string,
  input: RefundInput,
): Promise<RefundResult> {
  const admin = await getManagerIdentity("orders");
  if (!admin) return { error: "Not authenticated" };

  if (typeof orderId !== "string" || !orderId.trim()) {
    return { error: "Invalid order." };
  }
  if (!DASHBOARD_REFUND_METHODS.includes(input?.method)) {
    return { error: "Choose how the money goes back." };
  }
  const storeId = await getActingStoreId();
  const reason = input.reason?.trim().slice(0, 200) || null;
  const reference = input.reference?.trim().slice(0, 120) || null;

  // A manual refund's reference is the ONLY evidence the row will ever carry
  // — the money moved somewhere this system cannot see. Requiring it is what
  // separates a record from an assertion.
  if (input.method === "manual" && !reference) {
    return {
      error:
        "Add a reference (the UPI or bank transaction id) so this refund can be traced later.",
    };
  }

  // ── Who may give money back ──────────────────────────────────────────────
  // Weaker than the POS owner-only DISCOUNT rule on purpose (§6.3): a refund
  // leaves a physical trace — the goods come back and can be counted — whereas
  // a discount leaves nothing at all. So the default is "anyone who manages
  // orders", and a merchant tightens it if they want to.
  //
  // `maxRefundWithoutApproval` reads as "above this, only the owner". The POS
  // variant of the same idea takes a manager's SIGNED PIN grant; there is no
  // dashboard analogue of standing at a keypad, so here the escalation goes to
  // the person whose money it is.
  const settings = await getStoreSettings();
  const ownerOnly = settings["returns.ownerOnlyRefunds"] === true;
  const approvalCap = Number(settings["returns.maxRefundWithoutApproval"]) || 0;
  // Resolved once: it is a DB read, and the amount check below repeats inside
  // the transaction where the final amount is known.
  const superadmin =
    ownerOnly || approvalCap > 0 ? await isStoreSuperadmin() : true;

  if (ownerOnly && !superadmin) {
    return { error: "Only the store owner can issue refunds." };
  }

  // Settle anything still in flight before deciding what's left — otherwise a
  // refund that timed out earlier is invisible to the cap and its amount gets
  // handed back a second time.
  await reconcileOrderRefunds(orderId);

  // ── 1. Reserve the amount and write the row, in ONE transaction ──────────
  // withService wraps the callback in BEGIN/COMMIT, and the SELECT ... FOR
  // UPDATE locks the order row — so two admins clicking Refund at the same
  // moment serialise here. Without the lock both would read the same
  // "refundable" and both would pass the cap, which is how an order gets
  // refunded twice with every individual check passing.
  let reserved:
    | { refundId: string; key: string; amount: number; order: OrderForRefund }
    | { error: string };
  try {
    reserved = await withService(async (db) => {
      const rows = await db
        .select({
          id: orders.id,
          store_id: orders.storeId,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          status: orders.status,
          total: orders.total,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          razorpay_payment_id: orders.razorpayPaymentId,
          razorpay_order_id: orders.razorpayOrderId,
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
        .limit(1)
        .for("update");
      const found = rows[0];
      if (!found) return { error: "Order not found." };
      const order: OrderForRefund = {
        ...found,
        total: Number(found.total ?? 0),
      };

      if (input.method === "razorpay") {
        if (order.payment_method !== "razorpay") {
          return {
            error:
              "This order wasn't paid online, so it can't be refunded through the gateway.",
          };
        }
        if (order.payment_status !== "paid") {
          return {
            error: "This order was never paid, so there's nothing to refund.",
          };
        }
      }

      const existing = await db
        .select({ amount: orderRefunds.amount, status: orderRefunds.status })
        .from(orderRefunds)
        .where(eq(orderRefunds.orderId, orderId));

      const refundable = refundableAmount({
        orderTotal: order.total,
        refunds: existing.map((r) => ({
          amount: Number(r.amount ?? 0),
          status: r.status,
        })),
      });
      const checked = checkRefundAmount(input.amount, refundable);
      if ("error" in checked) return { error: checked.error };

      // ★ Re-checked HERE, not just up front: an omitted amount means "refund
      // everything left", and what that resolves to is only known now. A cap
      // enforced solely against `input.amount` would be trivially bypassed by
      // leaving the field blank.
      if (approvalCap > 0 && checked.amount > approvalCap && !superadmin) {
        return {
          error: `Refunds over ${formatCap(approvalCap)} need the store owner.`,
        };
      }

      const key = randomUUID();
      const inserted = await db
        .insert(orderRefunds)
        .values({
          storeId,
          orderId,
          method: input.method,
          amount: checked.amount,
          // A manual refund records money the merchant has ALREADY moved, so
          // there is nothing in flight and nothing to reconcile. Only the
          // gateway path starts life pending.
          status: input.method === "razorpay" ? "pending" : "completed",
          idempotencyKey: key,
          reason,
          reference,
          actor: admin.email ?? admin.uid,
        })
        .returning({ id: orderRefunds.id });

      return {
        refundId: inserted[0]!.id,
        key,
        amount: checked.amount,
        order,
      };
    });
  } catch (err) {
    logError("refund.reserve", err, { orderId });
    return { error: dbErrorMessage(err, "Couldn't start the refund.") };
  }
  if ("error" in reserved) return { error: reserved.error };

  const { refundId, key, amount, order } = reserved;

  // ── 2. Manual: nothing to call, the money already moved ──────────────────
  if (input.method === "manual") {
    await syncOrderRefundState(orderId);
    await announce(order, storeId, admin, amount, "manual");
    revalidatePath("/dashboard/orders");
    return { refundId, status: "completed", amount };
  }

  // ── 3. Gateway ───────────────────────────────────────────────────────────
  const gateway = await getStoreGateway(storeId);
  if (!gateway) {
    await failRefund(refundId, "Razorpay isn't connected for this store.");
    return {
      error:
        "Your Razorpay account isn't connected. Reconnect it in Channels, or record the refund manually.",
    };
  }

  let paymentId = order.razorpay_payment_id;
  if (!paymentId && order.razorpay_order_id) {
    const payments = await rzpFetchOrderPayments(
      gateway.creds,
      order.razorpay_order_id,
    );
    if (payments.ok) paymentId = capturedPayment(payments.data)?.id ?? null;
  }
  if (!paymentId) {
    await failRefund(refundId, "No captured payment found for this order.");
    return {
      error:
        "We couldn't find the captured payment for this order at Razorpay. Refund it from your Razorpay dashboard and record it here as a manual refund.",
    };
  }

  const res = await rzpRefund(gateway.creds, {
    paymentId,
    amountPaise: toPaise(amount),
    idempotencyKey: key,
    notes: {
      sm_order_ref: order.order_ref ?? "",
      sm_store_id: storeId,
    },
  });

  if (!res.ok) {
    if (res.outcome === "unknown") {
      // ★ DO NOT fail the row and DO NOT retry. The refund may well exist at
      // Razorpay; reconcile will find it by the key we planted. Telling the
      // merchant "it failed" here is what produces a second refund of the
      // same money.
      logError("refund.gateway_unknown", res.error, { orderId, refundId });
      return {
        refundId,
        status: "pending",
        amount,
        pendingReconcile: true,
      };
    }
    // A 4xx is a verdict: nothing happened, so free the amount.
    await failRefund(refundId, res.error);
    return { error: res.error };
  }

  // Razorpay returns `processed` straight away for most refunds and `pending`
  // for the instant/UPI ones that settle later — mapped, never assumed.
  const next = mapCreateStatus(res.data.status);
  const claimed = await withService((db) =>
    db
      .update(orderRefunds)
      .set({ status: next, gatewayRefundId: res.data.id })
      .where(
        and(eq(orderRefunds.id, refundId), eq(orderRefunds.status, "pending")),
      )
      .returning({ id: orderRefunds.id }),
  ).catch((err) => {
    // The money IS moving; only our record of it failed to update. Reconcile
    // fixes this from the gateway, so it must not read as a failed refund.
    logError("refund.settle_write", err, { orderId, refundId });
    return [] as { id: string }[];
  });

  // Losing the claim means something else settled this row first (a concurrent
  // reconcile) or the write failed. Either way we don't know the outcome from
  // here, and "pending" is the honest answer — it sends the UI to "we're
  // checking" rather than asserting a state we didn't write.
  const status: RefundStatus = claimed.length ? next : "pending";
  if (status === "completed") await syncOrderRefundState(orderId);
  await announce(order, storeId, admin, amount, "razorpay");

  revalidatePath("/dashboard/orders");
  return { refundId, status, amount, pendingReconcile: status === "pending" };
}

/** ₹ for a message, without dragging Intl into a hot path. */
function formatCap(amount: number): string {
  return `₹${amount.toFixed(2)}`;
}

function mapCreateStatus(rzpStatus: string): RefundStatus {
  return rzpStatus === "processed"
    ? "completed"
    : rzpStatus === "failed"
      ? "failed"
      : "pending";
}

/** Free the reserved amount when the gateway definitively refused. Conditional
 *  on still being pending, so it can never overwrite a settled refund. */
async function failRefund(refundId: string, why: string): Promise<void> {
  await withService((db) =>
    db
      .update(orderRefunds)
      .set({ status: "failed", reason: sql`left(${why}, 200)` })
      .where(
        and(eq(orderRefunds.id, refundId), eq(orderRefunds.status, "pending")),
      ),
  ).catch((err) => logError("refund.mark_failed", err, { refundId }));
}

/**
 * Tell the team and the customer.
 *
 * `order.refund_issued` is already registered and already emitted by the till
 * (pos-return-actions), so no coverage change is needed — but the till was the
 * ONLY emitter, which is exactly the gap §24 warns the coverage guard cannot
 * catch: it asserts a key is emitted somewhere, not that every path which
 * should emit it does.
 */
async function announce(
  order: OrderForRefund,
  storeId: string,
  admin: { uid: string; email: string | null },
  amount: number,
  method: string,
): Promise<void> {
  emitEvent({
    type: "order.refund_issued",
    storeId,
    actor: { type: "admin", id: admin.uid, label: admin.email },
    subject: { type: "order", id: order.id, label: order.order_ref },
    customerId: order.customer_id,
    payload: {
      orderRef: order.order_ref ?? "",
      total: amount,
      currency: "INR",
      paymentMethod: method,
    },
  });
}
