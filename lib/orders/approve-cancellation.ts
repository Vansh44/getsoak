import "server-only";

// ---------------------------------------------------------------------------
// Cancelling an order, once someone has decided to (roadmap Step 2).
//
// ★ ONE IMPLEMENTATION, THREE CALLERS: the merchant's Approve button, the
// merchant's own Cancel Order panel, and the customer path when a merchant has
// switched automatic approval on. A second hand-written copy of "claim the
// status, give back the stock, move the money, tell everyone" is how one of
// those three quietly stops restocking — the same reasoning that pulled
// lib/orders/cancel.ts out of updateOrderStatus.
//
// ★ WHOLE-ORDER ONLY. It takes an order id and cancels that order. There is no
// per-line variant and none is planned; per-item cancellation needs partial
// fulfilment, which this system does not have.
//
// ORDER OF OPERATIONS, and why:
//   1. claim status → cancelled     conditional, so it happens exactly once
//   2. give back stock              idempotent, best-effort (cancel.ts)
//   3. move the money               may fail; must NEVER be reported as success
//   4. tell the customer            only after the above have had their say
// ---------------------------------------------------------------------------

import { and, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orders } from "@/drizzle/schema";
import { releaseCancelledOrder } from "@/lib/orders/cancel";
import { issueRefund } from "@/lib/payments/issue-refund";
import { refundDueForOrder } from "@/lib/payments/refund-reconcile";
import { emitEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
import {
  cancelReasonLabel,
  type RefundDestination,
} from "@/lib/orders/cancellation";

/** Statuses an order can still be cancelled out of. Anything beyond these has
 *  shipped or been handed over, and is a return rather than a cancellation. */
const CANCELLABLE_FROM = ["pending", "processing"] as const;

export interface ApproveCancellationInput {
  storeId: string;
  orderId: string;
  /** Who decided — an admin uid, or the customer's own id on auto-approve. */
  actorId: string | null;
  actorLabel: string | null;
  /** The order's customer, for store credit and for the notification. */
  customerId?: string | null;
  refundDestination: RefundDestination;
  reasonCode: string;
  restock: boolean;
  notify: boolean;
  staffNote?: string | null;
  /** True when this came from a customer request rather than the merchant. */
  fromRequest?: boolean;
}

export interface ApproveCancellationResult {
  success?: boolean;
  error?: string;
  /** What is still owed after this ran. */
  refundDue?: number;
  /** Set when the order was cancelled but the MONEY did not move. The caller
   *  must surface this — reporting a bare success here is how a customer is
   *  told they have been refunded when they have not. */
  refundError?: string;
  /** The refund is REAL and in flight; the gateway's answer never arrived.
   *  ★ The UI must not invite a retry (CODEBASE §26) — say "we're checking". */
  refundPending?: boolean;
}

export async function approveCancellation(
  input: ApproveCancellationInput,
): Promise<ApproveCancellationResult> {
  const { storeId, orderId } = input;

  // ── 1. Claim it ─────────────────────────────────────────────────────────
  // The WHERE re-checks the status inside the statement that changes it, so a
  // dispatch racing this cancellation means one of them matches nothing rather
  // than both "succeeding". It is also what makes a double-clicked Approve
  // cancel once.
  let claimed:
    | {
        id: string;
        order_ref: string | null;
        total: number | null;
        payment_status: string | null;
        payment_method: string | null;
        customer_id: string | null;
      }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .update(orders)
        .set({
          status: "cancelled",
          cancellationStatus: "approved",
          cancellationDecidedAt: sql`now()`,
          cancellationDecidedBy: input.actorId,
          cancelReason: input.reasonCode,
          cancelRefundDestination: input.refundDestination,
          ...(input.staffNote ? { cancelStaffNote: input.staffNote } : {}),
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, storeId),
            inArray(orders.status, [...CANCELLABLE_FROM]),
          ),
        )
        .returning({
          id: orders.id,
          order_ref: orders.orderRef,
          total: orders.total,
          payment_status: orders.paymentStatus,
          payment_method: orders.paymentMethod,
          customer_id: orders.customerId,
        }),
    );
    claimed = rows[0];
  } catch (error) {
    logError("approveCancellation: claim failed", error, { orderId });
    return { error: "Couldn't cancel that order. Please try again." };
  }
  if (!claimed) {
    return {
      error:
        "This order has moved on and can't be cancelled now — it may already be cancelled or fulfilled.",
    };
  }

  // ── 2. Give the stock back ───────────────────────────────────────────────
  // Best-effort and idempotent, exactly as the dashboard path already treats
  // it: the status change is the source of truth and must never be blocked by
  // a stock write. Skipped entirely when the merchant said not to restock —
  // damaged or already-picked goods are theirs to judge.
  if (input.restock) {
    await releaseCancelledOrder(
      storeId,
      orderId,
      withService,
      input.fromRequest ? "customer_cancelled" : "order_cancelled",
    );
  }

  // ── 3. Move the money ────────────────────────────────────────────────────
  const total = Number(claimed.total ?? 0);
  const customerId = input.customerId ?? claimed.customer_id;
  let refundError: string | undefined;
  let pendingRefund = false;

  if (input.refundDestination !== "later") {
    // ★ BOTH DESTINATIONS GO THROUGH THE ONE REFUND MECHANISM (CODEBASE §26,
    // §28). `issueRefund` already knows `store_credit` as a method, so using it
    // for both means: an `order_refunds` row either way (so `refundDueForOrder`
    // and the order's payment_status stay correct), the refund CAP applied to
    // both, and the pending-row-first idempotency that stops a timeout being
    // re-sent as a second refund. Calling `issueCredit` directly here would
    // credit the customer with no refund row behind it — money out that the
    // order does not know about.
    const method =
      input.refundDestination === "store_credit" ? "store_credit" : "razorpay";
    if (input.refundDestination === "store_credit" && !customerId) {
      refundError =
        "This order has no customer account, so store credit couldn't be issued.";
    } else {
      const res = await issueRefund({
        storeId,
        orderId,
        customerId,
        method,
        actor: input.actorLabel ?? input.actorId ?? "system",
        reason: `Cancelled — ${cancelReasonLabel(input.reasonCode)}`,
      }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));

      if ("pendingReconcile" in res && res.pendingReconcile) {
        // ★ AN UNKNOWN ANSWER IS NOT A FAILURE (CODEBASE §26). The refund is
        // real and in flight; the gateway's reply just never arrived, and
        // reconcile-on-read will settle it. Reporting this as an error is how
        // someone refunds a second time and the customer is paid twice — so it
        // is deliberately NOT set as refundError.
        pendingRefund = true;
      } else if (res.error) {
        // ★ NEVER REPORTED AS SUCCESS. The order IS cancelled — that claim
        // already committed and undoing it would be worse — but the money did
        // not move, and the caller has to say so. Silently swallowing this is
        // how a customer is told they have been refunded when they have not.
        refundError = res.error;
      }
    }
  }
  // "later" moves nothing, deliberately: it records the obligation, and the
  // refund panel shows what is still owed.

  if (refundError) {
    logError("approveCancellation: refund failed", refundError, {
      orderId,
      destination: input.refundDestination,
    });
  }

  // ── 4. Tell people ───────────────────────────────────────────────────────
  const refundDue = await refundDueForOrder({
    id: orderId,
    total: claimed.total,
    paymentStatus: claimed.payment_status,
  }).catch(() => 0);

  if (input.notify) {
    emitEvent({
      type: "order.cancelled",
      storeId,
      actor: input.fromRequest
        ? { type: "customer", id: input.actorId, label: input.actorLabel }
        : { type: "admin", id: input.actorId, label: input.actorLabel },
      subject: { type: "order", id: orderId, label: claimed.order_ref },
      customerId,
      payload: {
        orderRef: claimed.order_ref ?? "",
        status: "cancelled",
        total,
        currency: "INR",
        reason: cancelReasonLabel(input.reasonCode),
        refund_destination: input.refundDestination,
        // Surfaced BECAUSE "later" pays nothing automatically — this is how the
        // merchant and the customer both learn what is still owed.
        ...(refundDue > 0 ? { refund_due: refundDue } : {}),
      },
      // ★ The staff note is NOT in the payload. It is internal, and the payload
      // feeds customer-facing templates.
    });
  }

  return {
    success: true,
    refundDue,
    refundError,
    ...(pendingRefund ? { refundPending: true } : {}),
  };
}
