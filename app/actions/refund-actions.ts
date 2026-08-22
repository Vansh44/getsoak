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

import { and, desc, eq } from "drizzle-orm";
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
import { getCreditBalance } from "@/lib/credit/store-credit";
import { emitEvent } from "@/lib/notifications/record";
import { getStoreGateway } from "@/lib/payments/provider";
import {
  DASHBOARD_REFUND_METHODS,
  refundableAmount,
  type RefundStatus,
} from "@/lib/payments/refunds";
import { reconcileOrderRefunds } from "@/lib/payments/refund-reconcile";
import { issueRefund } from "@/lib/payments/issue-refund";

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
  /** GST credit note serial, once the refund has settled on a taxed order.
   *  Allocated by a trigger — see returns_04_credit_notes.sql. */
  creditNoteRef: string | null;
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
  /** Whether this order has a customer account to credit. A walk-in doesn't. */
  canRefundToCredit: boolean;
  /** What they already hold here, so the merchant can see the effect. */
  creditBalance: number;
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
        creditNoteRef: orderRefunds.creditNoteRef,
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
        canRefundToCredit: Boolean(order.customer_id),
        creditBalance: order.customer_id
          ? await getCreditBalance(storeId, order.customer_id)
          : 0,
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

  // The mechanism lives in lib/payments/issue-refund.ts — shared with the
  // till (BORIS), because the money mechanics are identical and a second
  // hand-written copy of the pending-row-first idempotency is how a customer
  // gets refunded twice. Everything above this line is the DASHBOARD's
  // authorization; everything below it is reporting.
  const res = await issueRefund({
    storeId,
    orderId,
    amount: input.amount,
    method: input.method,
    actor: admin.email ?? admin.uid,
    reason,
    reference,
    // ★ Re-checked INSIDE the row lock, not just up front: an omitted amount
    // means "refund everything left", and what that resolves to is only known
    // there. A cap enforced solely against `input.amount` would be trivially
    // bypassed by leaving the field blank.
    checkAmount: (amount: number) =>
      approvalCap > 0 && amount > approvalCap && !superadmin
        ? `Refunds over ${formatCap(approvalCap)} need the store owner.`
        : null,
  });

  if (res.error) {
    // Tell a merchant at a desk where to fix it — they can actually get there.
    return {
      error:
        res.code === "gateway_not_connected"
          ? "Your Razorpay account isn't connected. Reconnect it in Channels, or record the refund manually."
          : res.code === "no_captured_payment"
            ? `${res.error} Refund it from your Razorpay dashboard and record it here as a manual refund.`
            : res.error,
    };
  }

  // A refund still in flight hasn't happened yet — announcing it would tell a
  // customer their money is back when it may still fail.
  if (res.status !== "pending") {
    emitEvent({
      type: "order.refund_issued",
      storeId,
      actor: { type: "admin", id: admin.uid, label: admin.email },
      subject: { type: "order", id: orderId, label: res.orderRef ?? null },
      customerId: res.customerId ?? null,
      payload: {
        orderRef: res.orderRef ?? "",
        // `amount` — the name variables.ts declares and both renderers read.
        // It was `total`, which templateValues drops as undeclared, so the
        // customer's refund email went out with no figure in it at all.
        amount: res.amount ?? 0,
        currency: "INR",
        paymentMethod: input.method,
      },
    });
  }

  revalidatePath("/dashboard/orders");
  return {
    refundId: res.refundId,
    status: res.status,
    amount: res.amount,
    pendingReconcile: res.pendingReconcile,
  };
}

/** ₹ for a message, without dragging Intl into a hot path. */
function formatCap(amount: number): string {
  return `₹${amount.toFixed(2)}`;
}
