import "server-only";

// Sending money back — the mechanism, with no opinion about who may.
//
// ── Why this module exists ─────────────────────────────────────────────────
// It lived inside `refundOrder`, which was right while the dashboard was the
// only place a refund could start. BORIS (returning an online order at a
// counter, roadmap Step 5) makes that two callers with completely different
// authorization — a dashboard manager identity versus a POS operator on an
// authorized device — but IDENTICAL money mechanics.
//
// A second hand-written copy of "reserve under a row lock, write the pending
// row first, call the gateway with our key, claim the transition, and treat an
// unknown outcome as not-a-failure" is the last thing this codebase should
// have. Get any one of those wrong in the copy and a customer is refunded
// twice — silently, and only at the till, where nobody is watching a log.
//
// ★ AUTHORIZATION IS THE CALLER'S JOB. Nothing here checks anything about the
// actor. `refundOrder` gates on getManagerIdentity + the owner-only settings;
// `processReturn` gates on resolvePosOperator + posCan("refund"). Both then
// call this. Convention #12's model, and the same split lib/orders/cancel.ts
// already uses.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orderRefunds, orders } from "@/drizzle/schema";
import { getStoreGateway } from "./provider";
import { capturedPayment, rzpFetchOrderPayments, rzpRefund } from "./razorpay";
import {
  checkRefundAmount,
  refundableAmount,
  toPaise,
  type RefundStatus,
} from "./refunds";
import {
  reconcileOrderRefunds,
  syncOrderRefundState,
} from "./refund-reconcile";
import { issueCredit } from "@/lib/credit/store-credit";
import { logError } from "@/lib/observability/logger";

/** Where the money physically goes. `razorpay` is the only one that moves it
 *  by itself; the rest RECORD money moved elsewhere (a drawer, a card
 *  terminal, a bank transfer the merchant made). */
export type IssueRefundMethod =
  | "razorpay"
  | "manual"
  | "cash"
  | "card"
  | "upi"
  | "store_credit";

export interface IssueRefundInput {
  storeId: string;
  orderId: string;
  /** Required for `store_credit` — there has to be somebody to credit. A
   *  walk-in with no account can't be given a balance. */
  customerId?: string | null;
  /** A server-verified counter payment id. POS split payments keep gateway
   *  ids on order_payments rather than the order row; passing that exact
   *  original reference lets a split return go back to its real source. */
  gatewayPaymentId?: string | null;
  /** Omit to refund everything still refundable. */
  amount?: number;
  method: IssueRefundMethod;
  /** Recorded on the row — who did this, in whatever form the caller has. */
  actor: string;
  reason?: string | null;
  reference?: string | null;
  /** Set for a till refund so the shift report can find it. NEVER set for a
   *  gateway refund — it doesn't touch a drawer. */
  locationId?: string | null;
  shiftId?: string | null;
  /** Links the money back to the goods, when there are goods. */
  returnId?: string | null;
  /**
   * Extra guard the caller wants applied INSIDE the row lock, once the amount
   * has resolved. Used by the dashboard's owner-approval cap, which can't be
   * checked up front when the amount is omitted ("refund everything left").
   */
  checkAmount?: (amount: number) => string | null;
}

export interface IssueRefundResult {
  refundId?: string;
  status?: RefundStatus;
  amount?: number;
  /** The gateway's answer never arrived. The refund is real and in flight —
   *  the UI must NOT invite a retry. */
  pendingReconcile?: boolean;
  /** For the caller's event payload. */
  orderRef?: string | null;
  customerId?: string | null;
  error?: string;
  /**
   * A stable reason, so a caller can say something its OWN audience can act
   * on. "Reconnect it in Channels" is right for a merchant at a desk and
   * useless to a cashier at a counter who has no way to get there.
   */
  code?:
    | "gateway_not_connected"
    | "no_captured_payment"
    | "gateway_refused"
    | "no_customer";
}

interface LockedOrder {
  id: string;
  order_ref: string | null;
  customer_id: string | null;
  total: number;
  /** The part of `total` settled with store credit, so no instrument saw it. */
  store_credit_used: number;
  payment_method: string | null;
  payment_status: string | null;
  razorpay_payment_id: string | null;
  razorpay_order_id: string | null;
}

export async function issueRefund(
  input: IssueRefundInput,
): Promise<IssueRefundResult> {
  const { storeId, orderId } = input;
  const reason = input.reason?.trim().slice(0, 200) || null;
  const reference = input.reference?.trim().slice(0, 120) || null;

  // Settle anything still in flight before deciding what's left — otherwise a
  // refund that timed out earlier is invisible to the cap and its amount gets
  // handed back a second time.
  await reconcileOrderRefunds(orderId);

  // ── 1. Reserve the amount and write the row, in ONE transaction ──────────
  // withService wraps the callback in BEGIN/COMMIT, and SELECT … FOR UPDATE
  // locks the order row — so two people refunding at the same moment
  // serialise here. Without the lock both would read the same "refundable"
  // and both would pass the cap, which is how an order gets refunded twice
  // with every individual check passing.
  let reserved:
    | { refundId: string; key: string; amount: number; order: LockedOrder }
    | { error: string };
  try {
    reserved = await withService(async (db) => {
      const rows = await db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          total: orders.total,
          store_credit_used: orders.storeCreditUsed,
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
      const order: LockedOrder = {
        ...found,
        total: Number(found.total ?? 0),
        store_credit_used: Number(found.store_credit_used ?? 0),
      };

      if (input.method === "razorpay") {
        if (order.payment_method !== "razorpay" && !input.gatewayPaymentId) {
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
        .select({
          amount: orderRefunds.amount,
          status: orderRefunds.status,
          method: orderRefunds.method,
        })
        .from(orderRefunds)
        .where(eq(orderRefunds.orderId, orderId));

      const refundable = refundableAmount({
        orderTotal: order.total,
        refunds: existing.map((r) => ({
          amount: Number(r.amount ?? 0),
          status: r.status,
          method: r.method,
        })),
        // A money refund can't exceed what money paid — the rest of the total
        // was settled with credit, which no instrument ever received.
        storeCreditUsed: order.store_credit_used,
        method: input.method,
      });
      const checked = checkRefundAmount(input.amount, refundable);
      if ("error" in checked) return { error: checked.error };

      // The caller's own rule, applied once the amount is REAL — an omitted
      // amount means "everything left", which nothing up front can check.
      const extra = input.checkAmount?.(checked.amount);
      if (extra) return { error: extra };

      const key = randomUUID();
      const inserted = await db
        .insert(orderRefunds)
        .values({
          storeId,
          orderId,
          returnId: input.returnId ?? null,
          // ★ A gateway refund never touches a drawer, so it must not carry a
          // shift — the cash report would count money that never left the till.
          locationId:
            input.method === "razorpay" ? null : (input.locationId ?? null),
          shiftId: input.method === "razorpay" ? null : (input.shiftId ?? null),
          method: input.method,
          amount: checked.amount,
          // Everything except the gateway RECORDS money that has already
          // moved, so there is nothing in flight and nothing to reconcile.
          status: input.method === "razorpay" ? "pending" : "completed",
          idempotencyKey: key,
          reason,
          reference,
          actor: input.actor,
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
    return { error: "Couldn't start the refund." };
  }
  if ("error" in reserved) return { error: reserved.error };

  const { refundId, key, amount, order } = reserved;
  const identity = {
    orderRef: order.order_ref,
    customerId: order.customer_id,
  };

  // ── 2. Store credit: no money moves, a balance appears ───────────────────
  // Done AFTER the refund row so the row is the thing being credited FOR —
  // its id is the idempotency ref, which makes a retry a no-op rather than a
  // second credit.
  if (input.method === "store_credit") {
    const customerId = input.customerId ?? order.customer_id;
    if (!customerId) {
      await failRefund(refundId, "No customer to credit.");
      return {
        code: "no_customer",
        error:
          "This order has no customer account, so there's nobody to give store credit to.",
      };
    }
    const credited = await issueCredit({
      storeId,
      customerId,
      amount,
      kind: "refund",
      ref: refundId,
      note: `Refund on ${order.order_ref ?? orderId}`,
      actor: input.actor,
    });
    if (!credited.ok) {
      await failRefund(
        refundId,
        credited.error ?? "Couldn't add store credit.",
      );
      return { error: credited.error ?? "Couldn't add store credit." };
    }
    await syncOrderRefundState(orderId);
    return { refundId, status: "completed", amount, ...identity };
  }

  // ── 3. Other non-gateway: the money already moved ────────────────────────
  if (input.method !== "razorpay") {
    await syncOrderRefundState(orderId);
    return { refundId, status: "completed", amount, ...identity };
  }

  // ── 4. Gateway ───────────────────────────────────────────────────────────
  const gateway = await getStoreGateway(storeId);
  if (!gateway) {
    await failRefund(refundId, "Razorpay isn't connected for this store.");
    return {
      code: "gateway_not_connected",
      error:
        "This store's Razorpay account isn't connected, so the card can't be refunded.",
    };
  }

  let paymentId = input.gatewayPaymentId ?? order.razorpay_payment_id;
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
      code: "no_captured_payment",
      error:
        "We couldn't find the captured payment for this order at Razorpay.",
    };
  }

  const res = await rzpRefund(gateway.creds, {
    paymentId,
    amountPaise: toPaise(amount),
    idempotencyKey: key,
    notes: { sm_order_ref: order.order_ref ?? "", sm_store_id: storeId },
  });

  if (!res.ok) {
    if (res.outcome === "unknown") {
      // ★ DO NOT fail the row and DO NOT retry. The refund may well exist at
      // Razorpay; reconcile will find it by the key we planted. Reporting it
      // as a failure is what produces a second refund of the same money.
      logError("refund.gateway_unknown", res.error, { orderId, refundId });
      return {
        refundId,
        status: "pending",
        amount,
        pendingReconcile: true,
        ...identity,
      };
    }
    // A 4xx is a verdict: nothing happened, so free the amount.
    await failRefund(refundId, res.error);
    return { code: "gateway_refused", error: res.error };
  }

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

  // Losing the claim means something else settled the row first, or the write
  // failed. Either way we don't know from here, and "pending" is the honest
  // answer — it sends the UI to "we're checking" rather than asserting a state
  // we didn't write.
  const status: RefundStatus = claimed.length ? next : "pending";
  if (status === "completed") await syncOrderRefundState(orderId);

  return {
    refundId,
    status,
    amount,
    pendingReconcile: status === "pending",
    ...identity,
  };
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
