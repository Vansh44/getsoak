import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal Razorpay REST client — plain fetch + basic auth, no SDK (the SDK
// pulls a dependency tree for what is three endpoints). Used both for a
// store's BYO gateway (order payments, creds from store_payment_providers)
// and the PLATFORM's own account (AI-credit purchases, creds from env).
//
// Docs: https://razorpay.com/docs/api/orders/ + /payments/

const RZP_BASE = "https://api.razorpay.com/v1";

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
}

function authHeader(creds: RazorpayCreds): string {
  return `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`;
}

export interface RzpOrder {
  id: string;
  amount: number; // paise
  currency: string;
  receipt: string | null;
  status: string;
}

export interface RzpPayment {
  id: string;
  order_id: string;
  amount: number; // paise
  status: string; // created | authorized | captured | refunded | failed
}

/**
 * `outcome` separates "Razorpay said no" from "we never found out".
 *
 * It matters for exactly one caller — refunds. A 4xx is a verdict: the request
 * was rejected and nothing happened, so the refund row can be failed and its
 * amount freed. A 5xx or a network throw is NOT a verdict: the refund may well
 * have been created, and treating it as a failure is how a customer gets paid
 * twice. Every other caller can ignore this field.
 */
export type RzpResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; outcome: "rejected" | "unknown" };

async function rzpFetch<T>(
  creds: RazorpayCreds,
  path: string,
  init?: RequestInit,
): Promise<RzpResult<T>> {
  try {
    const res = await fetch(`${RZP_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: authHeader(creds),
        "Content-Type": "application/json",
        ...init?.headers,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // Razorpay error bodies: { error: { code, description } }
      let description = `Razorpay request failed (${res.status})`;
      try {
        const body = (await res.json()) as {
          error?: { description?: string };
        };
        if (body?.error?.description) description = body.error.description;
      } catch {
        // non-JSON error body — keep the status message
      }
      return {
        ok: false,
        error: description,
        // A 5xx means their side broke partway; the write may still have
        // landed. Only a 4xx is a decision.
        outcome: res.status >= 500 ? "unknown" : "rejected",
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Razorpay request failed",
      // A timeout is indistinguishable from a success we never read.
      outcome: "unknown",
    };
  }
}

/** Create a Razorpay Order for the given (server-computed!) amount. */
export async function rzpCreateOrder(
  creds: RazorpayCreds,
  params: {
    amountPaise: number;
    receipt?: string;
    notes?: Record<string, string>;
  },
): Promise<RzpResult<RzpOrder>> {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
    // Razorpay's own minimum is ₹1 (100 paise).
    return {
      ok: false,
      error: "Amount too small for an online payment.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpOrder>(creds, "/orders", {
    method: "POST",
    body: JSON.stringify({
      amount: params.amountPaise,
      currency: "INR",
      receipt: params.receipt,
      notes: params.notes,
    }),
  });
}

/** All payment attempts against a Razorpay order — the reconciliation source
 *  of truth (a `captured` payment here means the money was taken). */
export async function rzpFetchOrderPayments(
  creds: RazorpayCreds,
  rzpOrderId: string,
): Promise<RzpResult<RzpPayment[]>> {
  const res = await rzpFetch<{ items: RzpPayment[] }>(
    creds,
    `/orders/${encodeURIComponent(rzpOrderId)}/payments`,
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.items ?? [] };
}

/** The captured payment on an order, if any. */
export function capturedPayment(payments: RzpPayment[]): RzpPayment | null {
  return payments.find((p) => p.status === "captured") ?? null;
}

// ───────────────────────────────── Refunds ─────────────────────────────────
// Money going back out (roadmap Step 2, docs/returns-exchanges-plan.md §3.2).
//
// Refunds are the one call here where a retry is DANGEROUS: a timeout is
// indistinguishable from a failure, and retrying blind pays the customer
// twice. So every create carries an idempotency key the CALLER generated and
// persisted first — see refundOrder in app/actions/refund-actions.ts.

export interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number; // paise
  /** pending | processed | failed */
  status: string;
  notes?: Record<string, string> | null;
  speed_processed?: string | null;
}

/**
 * Refund (part of) a captured payment.
 *
 * `idempotencyKey` is sent BOTH as Razorpay's idempotency header — so a repeat
 * with the same key returns the original refund instead of making a second one
 * — and inside `notes`, so the reconcile sweep can match a refund back to the
 * row that asked for it EXACTLY, rather than guessing from the amount (two
 * legitimate ₹500 refunds on one order are indistinguishable by amount).
 *
 * The notes copy is the load-bearing half: it is the one that still works if
 * the header is ever unsupported, renamed, or silently ignored.
 */
export async function rzpRefund(
  creds: RazorpayCreds,
  params: {
    paymentId: string;
    amountPaise: number;
    idempotencyKey: string;
    notes?: Record<string, string>;
  },
): Promise<RzpResult<RzpRefund>> {
  // Both are our own preconditions, so nothing was sent and nothing happened —
  // "rejected", which lets the caller free the amount rather than leaving a
  // refund pending against a call that was never made.
  if (!params.paymentId) {
    return {
      ok: false,
      error: "No payment to refund.",
      outcome: "rejected",
    };
  }
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
    // Razorpay's floor is ₹1, same as a payment.
    return {
      ok: false,
      error: "Amount too small to refund online.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpRefund>(
    creds,
    `/payments/${encodeURIComponent(params.paymentId)}/refund`,
    {
      method: "POST",
      headers: { "X-Razorpay-Idempotency-Key": params.idempotencyKey },
      body: JSON.stringify({
        amount: params.amountPaise,
        notes: { ...params.notes, sm_refund_key: params.idempotencyKey },
      }),
    },
  );
}

/** Every refund recorded against a payment — the reconciliation source of
 *  truth when a create call's outcome was never learned. */
export async function rzpFetchPaymentRefunds(
  creds: RazorpayCreds,
  paymentId: string,
): Promise<RzpResult<RzpRefund[]>> {
  const res = await rzpFetch<{ items: RzpRefund[] }>(
    creds,
    `/payments/${encodeURIComponent(paymentId)}/refunds`,
  );
  if (!res.ok) return res;
  return { ok: true, data: res.data.items ?? [] };
}

/** Cheap authenticated call to prove a key pair works ("Verify & save"). */
export async function validateCredentials(
  creds: RazorpayCreds,
): Promise<RzpResult<true>> {
  const res = await rzpFetch<unknown>(creds, "/orders?count=1");
  if (!res.ok) return res;
  return { ok: true, data: true };
}

/**
 * Razorpay Standard Checkout success signature:
 *   HMAC-SHA256(key_secret, `${order_id}|${payment_id}`) === signature.
 * Pure (no I/O) — unit-tested with a known vector. Constant-time compare.
 */
export function verifyCheckoutSignature(
  keySecret: string,
  rzpOrderId: string,
  rzpPaymentId: string,
  signature: string,
): boolean {
  if (!keySecret || !rzpOrderId || !rzpPaymentId || !signature) return false;
  const expected = createHmac("sha256", keySecret)
    .update(`${rzpOrderId}|${rzpPaymentId}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─────────────────────────── Subscriptions (autopay) ───────────────────────
/**
 * Razorpay WEBHOOK signature (Phase 2): HMAC-SHA256 of the RAW request body
 * with the webhook secret, compared to the X-Razorpay-Signature header. Pure.
 */
export function verifyWebhookSignature(
  webhookSecret: string,
  rawBody: string,
  signature: string,
): boolean {
  if (!webhookSecret || !rawBody || !signature) return false;
  const expected = createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
