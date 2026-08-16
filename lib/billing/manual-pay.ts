import "server-only";

/**
 * Manual payment — paying an open invoice on session.
 *
 * Design: docs/billing-architecture.md §7. Spec §18: manual payment is a
 * FIRST-CLASS path, not a fallback bolted on. It is how an invoice is settled
 * whenever automatic collection cannot or must not run.
 *
 * It is needed in five situations the spec names, and one it does not:
 *   • no mandate, or a revoked or expired one
 *   • the amount is over the ₹15,000 AFA-exempt limit (every yearly plan)
 *   • automatic collection failed and the merchant wants to fix it now
 *   • during the 48-hour grace window
 *   • ★ while automatic collection is unavailable during an incident
 *
 * ★★ PAYING DURING GRACE RESTORES THE PLAN IMMEDIATELY. Settling the invoice and
 * leaving the cycle to the hourly worker would keep a merchant who has just paid
 * locked out of their own POS for up to an hour, at the moment they are watching
 * the screen. So the advance runs here too — through the SAME function the worker
 * uses, never a second copy of the rule.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { billingInvoices, billingPaymentAttempts } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  verifyCapturedCheckoutPayment,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import { beginAttempt, settleAttempt } from "./collect";
import type { PayableInvoice } from "./invoice-types";
import {
  amountDueForInvoice,
  finalizeInvoice,
  getInvoice,
} from "./invoice-store";
import { advanceAfterPayment } from "./renewal-worker";

export interface PaymentStart {
  invoiceId: string;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  invoiceRef: string | null;
}

export type PayResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Invoice states a merchant may still pay. */
const PAYABLE = ["open", "draft"] as const;

/**
 * Open a payment for an invoice the merchant already owes.
 *
 * ★ SCOPED BY STORE as well as invoice id. An invoice id alone must never let
 * one merchant pay — or even see the amount of — another's bill.
 */
export async function startInvoicePayment(input: {
  storeId: string;
  invoiceId: string;
  now?: Date;
}): Promise<PayResult<PaymentStart>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds)
    return { ok: false, error: "Payments aren't available right now." };

  const invoice = await getInvoice(input.invoiceId);
  if (!invoice || invoice.storeId !== input.storeId) {
    return { ok: false, error: "We couldn't find that invoice." };
  }

  // ★★ AI credits were paid in their own one-time Razorpay checkout. They have
  // an invoice for accounting, not an outstanding obligation. Even if a future
  // UI/query regression displays one here, never create another order for it.
  if (invoice.kind !== "subscription") {
    return {
      ok: false,
      error: "That one-time purchase is already settled.",
    };
  }

  if (invoice.status === "paid") {
    return { ok: false, error: "That invoice is already paid." };
  }
  // ★ `uncollectible` and `void` are DECISIONS, not states to pay out of. An
  // uncollectible invoice belongs to a cycle the merchant was already downgraded
  // for; taking money for it would charge them for a service period they never
  // received (§7). They re-subscribe instead.
  if (invoice.status === "uncollectible" || invoice.status === "void") {
    return {
      ok: false,
      error:
        "That invoice was closed unpaid and can't be settled. Subscribe again to start a new cycle.",
    };
  }
  if (invoice.status === "processing") {
    return {
      ok: false,
      error: "A payment is already being processed. Give it a moment.",
    };
  }
  if (!PAYABLE.includes(invoice.status as (typeof PAYABLE)[number])) {
    return { ok: false, error: "That invoice can't be paid." };
  }

  // An invoice must be issued before it is paid — the merchant is paying against
  // a document number.
  if (!invoice.finalizedAt) {
    const issued = await finalizeInvoice(invoice.id, now);
    if (!issued) return { ok: false, error: "Couldn't issue that invoice." };
  }

  const amountDue = await amountDueForInvoice(invoice.id);
  // Never guess (Rule 10). A null here means we could not read applied credit,
  // and quoting the full total might double-charge.
  if (amountDue === null) {
    return {
      ok: false,
      error: "Couldn't work out what's due. Please try again.",
    };
  }
  if (amountDue <= 0) {
    return { ok: false, error: "Nothing is due on that invoice." };
  }

  const attempt = await beginAttempt({
    invoiceId: invoice.id,
    storeId: input.storeId,
    amountPaise: amountDue,
    mode: "manual",
  });
  // ★ The partial unique index refused it: something is already collecting.
  // Three clicks on Pay, or the renewal worker charging this very invoice.
  if (!attempt) {
    return {
      ok: false,
      error: "A payment is already in progress. Give it a moment.",
    };
  }

  const order = await rzpCreateOrder(creds, {
    amountPaise: amountDue,
    receipt: invoice.invoiceRef ?? invoice.id.slice(0, 30),
    notes: {
      store_id: input.storeId,
      invoice_id: invoice.id,
      sm_billing_key: attempt.idempotencyKey,
    },
  });
  if (!order.ok) {
    await settleAttempt(
      attempt.attemptId,
      // An UNKNOWN leaves it in flight — the order may exist, and failing it
      // would let a second attempt open against the same money.
      order.outcome === "unknown" ? "unknown" : "failed",
      { failureCode: "order_create", failureReason: order.error, now },
    );
    return {
      ok: false,
      error: "Couldn't start the payment. Please try again.",
    };
  }

  await settleAttempt(attempt.attemptId, "processing", {
    providerOrderId: order.data.id,
    now,
  });

  return {
    ok: true,
    data: {
      invoiceId: invoice.id,
      providerOrderId: order.data.id,
      keyId: creds.keyId,
      amountPaise: amountDue,
      invoiceRef: invoice.invoiceRef,
    },
  };
}

export interface PaymentConfirmed {
  invoiceId: string;
  /** True when this payment ended a grace window and restored the plan. */
  planRestored: boolean;
}

/**
 * Settle a manual payment.
 *
 * ★ The HMAC is the trust boundary, verified against the order WE created. A
 * payment id from the browser proves nothing.
 */
export async function confirmInvoicePayment(input: {
  storeId: string;
  invoiceId: string;
  providerPaymentId: string;
  signature: string;
  now?: Date;
}): Promise<PayResult<PaymentConfirmed>> {
  const now = input.now ?? new Date();
  const creds = getPlatformRazorpayCreds();
  if (!creds)
    return { ok: false, error: "Payments aren't available right now." };

  let attempt: {
    id: string;
    providerOrderId: string | null;
    amountPaise: number;
  } | null = null;
  try {
    attempt = await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            eq(billingPaymentAttempts.invoiceId, input.invoiceId),
            eq(billingPaymentAttempts.storeId, input.storeId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.manual_confirm_load", err, {
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "Couldn't confirm that payment." };
  }

  if (!attempt?.providerOrderId) {
    return { ok: false, error: "No payment to confirm." };
  }

  if (
    !verifyCheckoutSignature(
      creds.keySecret,
      attempt.providerOrderId,
      input.providerPaymentId,
      input.signature,
    )
  ) {
    logWarn("billing.manual_bad_signature", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
    });
    return { ok: false, error: "We couldn't verify that payment." };
  }

  const observedPayment = await verifyCapturedCheckoutPayment(creds, {
    paymentId: input.providerPaymentId,
    orderId: attempt.providerOrderId,
    amountPaise: attempt.amountPaise,
  });
  if (!observedPayment.ok) {
    logWarn("billing.manual_gateway_mismatch", {
      storeId: input.storeId,
      invoiceId: input.invoiceId,
      reason: observedPayment.error,
    });
    return { ok: false, error: observedPayment.error };
  }

  const settled = await settleAttempt(attempt.id, "captured", {
    providerPaymentId: input.providerPaymentId,
    now,
  });
  // null means a concurrent settle won — the money is still accounted for.
  if (settled && settled !== "captured") {
    return { ok: false, error: "That payment didn't complete." };
  }

  // ★★ Restore the plan NOW rather than at the next cron tick, using the SAME
  // advance the worker uses. A merchant who has just paid must not stay locked
  // out of their own till for an hour.
  const planRestored = await advanceAfterPayment(input.storeId, now);

  return { ok: true, data: { invoiceId: input.invoiceId, planRestored } };
}

/**
 * Subscription invoices this store still owes, newest first — what a "pay now"
 * surface lists. One-time AI-credit invoices are receipts, never plan debt.
 *
 * Excludes `uncollectible` and `void`: both are closed decisions, and offering
 * to pay one would take money for a period the merchant never received.
 */
export async function listPayableInvoices(
  storeId: string,
): Promise<PayableInvoice[]> {
  try {
    return await withService(async (db) =>
      db
        .select({
          id: billingInvoices.id,
          invoiceRef: billingInvoices.invoiceRef,
          status: billingInvoices.status,
          totalPaise: billingInvoices.totalPaise,
          periodStart: billingInvoices.periodStart,
          periodEnd: billingInvoices.periodEnd,
          dueAt: billingInvoices.dueAt,
          createdAt: billingInvoices.createdAt,
        })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            eq(billingInvoices.kind, "subscription"),
            inArray(billingInvoices.status, ["open", "processing"]),
          ),
        )
        .orderBy(desc(billingInvoices.createdAt))
        .limit(20),
    );
  } catch (err) {
    logError("billing.list_payable", err, { storeId });
    return [];
  }
}
