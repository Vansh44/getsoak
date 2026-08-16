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

// ───────────────────────────────────────────────────────────────────────────
// Recurring (autopay). Verified against Razorpay's published API reference on
// 2026-08-14 — the endpoint paths and field names below are quoted from it, not
// inferred. What is NOT verified is the live behaviour: see
// docs/autopay-verification.md for the test-mode run that flips the flag in
// lib/billing/gateway.ts.
// ───────────────────────────────────────────────────────────────────────────

export interface RzpCustomer {
  id: string;
  name?: string;
  email?: string;
  contact?: string;
}

/**
 * A recurring mandate is attached to a CUSTOMER, not to an order, so one has to
 * exist before the authorisation order is created.
 *
 * ★ `fail_existing: "0"` makes this IDEMPOTENT — Razorpay returns the existing
 * customer instead of erroring when the email or contact already exists. That
 * matters because a merchant who abandons checkout and comes back must not be
 * blocked by their own half-finished first attempt.
 */
export async function rzpCreateCustomer(
  creds: RazorpayCreds,
  params: { name?: string; email?: string; contact?: string },
): Promise<RzpResult<RzpCustomer>> {
  if (!params.email && !params.contact) {
    return {
      ok: false,
      error: "A customer needs an email or a phone number.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpCustomer>(creds, "/customers", {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      email: params.email,
      contact: params.contact,
      fail_existing: "0",
    }),
  });
}

/** How often we may debit, and the ceiling per debit. */
export interface RzpMandateTerms {
  /**
   * The most Razorpay will EVER let us debit under this mandate.
   *
   * ★★ CAPPED AT ₹99,999 BY RAZORPAY for UPI mandates — their documented
   * maximum for `token.max_amount`. `lib/billing/cycle.ts` sizes the mandate and
   * clamps to it; an amount above the ceiling routes to manual collection
   * instead of failing at the gateway. Do not raise this without re-reading
   * their docs.
   */
  maxAmountPaise: number;
  /** Unix SECONDS. Razorpay wants a timestamp, not an ISO string. */
  expireAtUnix: number;
  frequency: "daily" | "weekly" | "monthly" | "yearly" | "as_presented";
}

/**
 * The FIRST payment — the one that registers the mandate.
 *
 * It is an ordinary order plus `customer_id` and a `token` block; the customer
 * approves both the payment and the standing authorisation in one checkout.
 */
export async function rzpCreateAuthorizationOrder(
  creds: RazorpayCreds,
  params: {
    amountPaise: number;
    customerId: string;
    terms: RzpMandateTerms;
    /** Omit to let the customer pick at checkout. "upi" pins UPI Autopay. */
    method?: "upi" | "card" | "emandate" | "nach";
    receipt?: string;
    description?: string;
    notes?: Record<string, string>;
  },
): Promise<RzpResult<RzpOrder>> {
  if (!Number.isInteger(params.amountPaise) || params.amountPaise < 100) {
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
      customer_id: params.customerId,
      ...(params.method ? { method: params.method } : {}),
      token: {
        max_amount: params.terms.maxAmountPaise,
        expire_at: params.terms.expireAtUnix,
        frequency: params.terms.frequency,
      },
      receipt: params.receipt,
      description: params.description,
      notes: params.notes,
    }),
  });
}

export interface RzpRecurringPayment {
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
  /** Present on some responses; absent ones are resolved by reconciliation. */
  status?: string;
}

/**
 * Charge an existing mandate — the SUBSEQUENT payment.
 *
 * ★★ IT NEEDS AN ORDER FIRST. `POST /payments/create/recurring` takes an
 * `order_id`, so a charge is TWO calls: create the order, then charge it. The
 * caller (lib/billing/gateway.ts) does both and treats a failure between them
 * as UNKNOWN, because an order with no payment is indistinguishable from a
 * payment we never read.
 *
 * ★ `email` and `contact` are MANDATORY per the API reference, which is why the
 * mandate stores the customer id and the caller resolves the billing contact.
 *
 * ⚠ Razorpay documents that for some banks the payment stays `created` rather
 * than reaching `captured` immediately (file-based charging). That is NOT a
 * failure — `mapGatewayStatus` already resolves `created` to a non-terminal
 * state, and reconciliation settles it later.
 */
export async function rzpChargeMandate(
  creds: RazorpayCreds,
  params: {
    amountPaise: number;
    orderId: string;
    customerId: string;
    tokenId: string;
    email: string;
    contact: string;
    description?: string;
    notes?: Record<string, string>;
  },
): Promise<RzpResult<RzpRecurringPayment>> {
  return rzpFetch<RzpRecurringPayment>(creds, "/payments/create/recurring", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      contact: params.contact,
      amount: params.amountPaise,
      currency: "INR",
      order_id: params.orderId,
      customer_id: params.customerId,
      token: params.tokenId,
      recurring: true,
      description: params.description,
      notes: params.notes,
    }),
  });
}

export interface RzpPaymentDetail {
  id: string;
  order_id?: string | null;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
  /** Present once an authorisation payment has registered a mandate. */
  token_id?: string | null;
  customer_id?: string | null;
}

export type CapturedCheckoutVerification =
  | { ok: true; gatewayRead: true }
  | { ok: true; gatewayRead: false }
  | { ok: false; error: string };

/**
 * Verify the browser callback against Razorpay's own payment record.
 *
 * The checkout HMAC remains mandatory at every caller. This is the second
 * boundary: a valid callback must also name a CAPTURED INR payment for the
 * exact order and amount StoreMink created. A temporary Razorpay read outage
 * falls back to the HMAC (and is reconciled later); a contradictory gateway
 * record fails closed and never grants an entitlement.
 */
export async function verifyCapturedCheckoutPayment(
  creds: RazorpayCreds,
  input: {
    paymentId: string;
    orderId: string;
    amountPaise: number;
  },
): Promise<CapturedCheckoutVerification> {
  const fetched = await rzpFetchPayment(creds, input.paymentId);
  if (!fetched.ok) {
    // The HMAC still proves association. Refusing to finish after a transient
    // read outage strands a captured payment and can make the merchant retry.
    return { ok: true, gatewayRead: false };
  }
  const payment = fetched.data;
  if (payment.id !== input.paymentId || payment.order_id !== input.orderId) {
    return { ok: false, error: "The payment belongs to a different order." };
  }
  if (payment.amount !== input.amountPaise || payment.currency !== "INR") {
    return {
      ok: false,
      error: "The captured amount does not match the invoice.",
    };
  }
  if (payment.status !== "captured") {
    return {
      ok: false,
      error:
        "The payment is still being confirmed. Don't pay again; check back shortly.",
    };
  }
  return { ok: true, gatewayRead: true };
}

/**
 * One payment, by id — and the ONLY honest way to learn a mandate's token.
 *
 * ★★ THE TOKEN IS READ HERE, NEVER TAKEN FROM THE CLIENT. Razorpay Checkout's
 * success handler hands the browser a payment id, an order id and a signature —
 * not a token — so any client-supplied `token_id` would be a value the browser
 * chose. Attaching a mandate the merchant did not authorise is a standing
 * permission to debit them; reading it from the payment we have just verified
 * removes the question entirely. Same rule as every price in this codebase.
 */
export async function rzpFetchPayment(
  creds: RazorpayCreds,
  paymentId: string,
): Promise<RzpResult<RzpPaymentDetail>> {
  return rzpFetch<RzpPaymentDetail>(
    creds,
    `/payments/${encodeURIComponent(paymentId)}`,
  );
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
  if (!/^[A-Za-z0-9_-]{10,}$/.test(params.idempotencyKey)) {
    // Razorpay rejects shorter keys and any punctuation outside `_` / `-`.
    // Rejecting before the request keeps this a known non-event instead of
    // relying on a provider 400 for a safety property we can prove locally.
    return {
      ok: false,
      error: "Invalid refund idempotency key.",
      outcome: "rejected",
    };
  }
  return rzpFetch<RzpRefund>(
    creds,
    `/payments/${encodeURIComponent(params.paymentId)}/refund`,
    {
      method: "POST",
      // Razorpay's refund API has its own idempotency header. This is NOT the
      // generic-looking `X-Razorpay-Idempotency-Key`: using that unrecognised
      // name silently removes the provider-side duplicate guard.
      headers: { "X-Refund-Idempotency": params.idempotencyKey },
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
