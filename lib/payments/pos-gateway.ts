import "server-only";

// Taking a gateway payment AT THE COUNTER (roadmap Step 12, CODEBASE §18).
//
// ── What was actually broken ───────────────────────────────────────────────
// Split payment was never the gap: lib/pos/tenders.ts has always taken up to
// six tenders and settled coverage and change in paise. The gap was that NO
// tender was ever verified. `card` and `upi` are, by the original design
// (docs/pos-plan.md §7, decision 8), an EXTERNAL terminal — the shop swipes on
// their own machine and the cashier types an amount and a reference. And
// `razorpay` sat in TENDER_METHODS with no gateway call behind it anywhere, so
// it was accepted, recorded, and counted in shift reconciliation as money the
// gateway never received.
//
// ── The rule this module exists to hold ────────────────────────────────────
// ★★ THE CAPTURED AMOUNT IS THE ONLY THING THAT MAKES A TENDER REAL. A client
// posting `{method:'razorpay', amount: 500, reference:'pay_x'}` must not settle
// a ₹500 sale when pay_x took ₹200. So verification compares the tender's own
// amount against Razorpay's record of the payment, in paise, with the STORE's
// own credentials — which is also what proves the payment belongs to this
// merchant at all, since Razorpay only returns payments on the account whose
// key made the request.
//
// ── Built only on primitives that are already verified ─────────────────────
// ⚠ §34 records that several Razorpay behaviours here are still unobserved in
// the wild. Everything below uses the THREE calls that have run in production
// since §18: create an order, fetch a payment, and check a checkout HMAC. No
// QR-code API, no payment links — those are new provider surface, and guessing
// at a shape is how a counter ends up with a payment nobody can confirm.

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orderPayments } from "@/drizzle/schema";
import {
  rzpCreateOrder,
  rzpFetchPayment,
  verifyCheckoutSignature,
  type RazorpayCreds,
} from "./razorpay";
import { getLiveStoreGateway } from "./provider";
import type { PosTender } from "@/lib/pos/tenders";
import { logError } from "@/lib/observability/logger";

/**
 * A sane ceiling for ONE counter tender.
 *
 * Not a business rule — Razorpay has its own limits and will refuse beyond
 * them. This exists so a mistyped amount cannot open a ₹40,00,000 order on the
 * merchant's account; the sale's real bound is `settleTenders`, which refuses
 * any non-cash tender above the server-computed total.
 */
export const MAX_COUNTER_PAYMENT_PAISE = 10_00_000 * 100;

export interface CounterPaymentStart {
  rzpOrderId: string;
  keyId: string;
  amountPaise: number;
}

export type CounterPaymentResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Is a gateway payment offerable at this store's counter right now? */
export async function counterGatewayKeyId(
  storeId: string,
): Promise<string | null> {
  const creds = await getLiveStoreGateway(storeId);
  return creds?.keyId ?? null;
}

/**
 * Open a Razorpay order for an amount the CASHIER named.
 *
 * ★ THE AMOUNT IS NOT RE-PRICED, AND THAT IS CORRECT. This is one leg of a
 * split — "₹200 of this on UPI" — so it is not derived from the cart at all.
 * The cart's authority is enforced where it belongs: `placePosSale` re-prices
 * the whole sale server-side, and `settleTenders` then refuses a non-cash
 * tender that exceeds that total. Charging a cart-derived amount here would be
 * wrong for every split payment, which is the case this exists for.
 */
export async function startCounterPayment(
  storeId: string,
  input: { amountPaise: number; receipt?: string; locationId?: string },
): Promise<CounterPaymentResult<CounterPaymentStart>> {
  const creds = await getLiveStoreGateway(storeId);
  if (!creds) {
    return {
      ok: false,
      error: "Online payments aren't switched on for this store.",
    };
  }
  const amountPaise = input.amountPaise;
  if (!Number.isInteger(amountPaise) || amountPaise < 100) {
    return { ok: false, error: "Enter at least ₹1 to take an online payment." };
  }
  if (amountPaise > MAX_COUNTER_PAYMENT_PAISE) {
    return { ok: false, error: "That's too large for a single card payment." };
  }

  const res = await rzpCreateOrder(creds, {
    amountPaise,
    receipt: input.receipt,
    // Notes are diagnostic only — never read back as authorisation. They make a
    // counter payment identifiable in the merchant's own Razorpay dashboard,
    // which is where they will look when reconciling a till.
    notes: {
      source: "storemink_pos",
      ...(input.locationId ? { location_id: input.locationId } : {}),
    },
  });
  if (!res.ok) {
    logError("pos.gateway_order", new Error(res.error), { storeId });
    return {
      ok: false,
      error:
        res.outcome === "rejected"
          ? "The payment gateway refused that amount."
          : "Couldn't reach the payment gateway. Try again.",
    };
  }
  return {
    ok: true,
    data: { rzpOrderId: res.data.id, keyId: creds.keyId, amountPaise },
  };
}

/**
 * Is this payment REALLY money in the merchant's account, for this amount?
 *
 * ★★ A GATEWAY READ FAILURE IS REFUSED HERE, unlike
 * `verifyCapturedCheckoutPayment`, which falls back to the HMAC. That fallback
 * is right online, where the order already exists in `pending` and a background
 * sweep reconciles it. A till sale has no pending state — it is born `paid` and
 * the goods leave the counter — so there is nothing to reconcile back from, and
 * an unverified completion is money the shop may never have received. The
 * customer's money is safe either way (captured at Razorpay), so the honest
 * answer is "we could not check, try again", not "confirmed".
 *
 * The HMAC is still required when a signature is supplied: it proves the
 * browser callback is genuine before we spend a round trip on it.
 */
export async function verifyCounterPayment(
  storeId: string,
  input: {
    paymentId: string;
    /** Both required together for the HMAC; omitted when re-verifying at sale
     *  time, where the payment id alone is what the tender carries. */
    rzpOrderId?: string;
    signature?: string;
    expectedPaise: number;
  },
): Promise<CounterPaymentResult<{ paymentId: string; amountPaise: number }>> {
  const creds = await getLiveStoreGateway(storeId);
  if (!creds) {
    return {
      ok: false,
      error: "Online payments aren't switched on for this store.",
    };
  }
  if (typeof input.paymentId !== "string" || !input.paymentId.trim()) {
    return { ok: false, error: "That payment reference isn't valid." };
  }

  if (input.signature) {
    if (!input.rzpOrderId) {
      return { ok: false, error: "That payment reference isn't valid." };
    }
    const genuine = verifyCheckoutSignature(
      creds.keySecret,
      input.rzpOrderId,
      input.paymentId,
      input.signature,
    );
    if (!genuine) {
      return { ok: false, error: "That payment couldn't be verified." };
    }
  }

  return verifyCapturedAmount(creds, input.paymentId, input.expectedPaise);
}

/** The gateway read, shared by the confirm step and the re-check at sale time. */
async function verifyCapturedAmount(
  creds: RazorpayCreds,
  paymentId: string,
  expectedPaise: number,
): Promise<CounterPaymentResult<{ paymentId: string; amountPaise: number }>> {
  const fetched = await rzpFetchPayment(creds, paymentId);
  if (!fetched.ok) {
    return {
      ok: false,
      error:
        "Couldn't confirm that payment with the gateway. Don't take it again — check and retry.",
    };
  }
  const p = fetched.data;
  if (p.status !== "captured") {
    return {
      ok: false,
      error:
        p.status === "failed"
          ? "That payment failed. Take it again or use another method."
          : "That payment hasn't completed yet. Don't take it again — retry in a moment.",
    };
  }
  if (p.currency !== "INR") {
    return { ok: false, error: "That payment wasn't in rupees." };
  }
  // ★★ THE CHECK THE WHOLE STEP EXISTS FOR. Without it a client could claim any
  // amount against a real ₹1 payment and settle the sale.
  if (p.amount !== expectedPaise) {
    return {
      ok: false,
      error: "The amount paid doesn't match what's being recorded.",
    };
  }
  return { ok: true, data: { paymentId: p.id, amountPaise: p.amount } };
}

/**
 * Prove every gateway tender on a transaction is real money, once, for us.
 *
 * ★★ ONE IMPLEMENTATION, TWO COUNTERS — `placePosSale` and `markCollected`.
 * This is a SECURITY check on a money path, and both actions are independently
 * reachable POST endpoints, so a second hand-written copy is how one counter
 * ends up settling against an unverified payment. Exactly the reasoning that
 * put the tender allowlist in lib/pos/tenders.ts and the refund mechanism in
 * lib/payments/issue-refund.ts.
 *
 * ★ CALL IT BEFORE ANYTHING IS WRITTEN. At the sell counter that means before
 * the order insert and the stock reserve; at the collection counter, before the
 * claim. A refusal then costs nothing and unwinds nothing.
 *
 * Returns an error message for the cashier, or null when every gateway tender
 * checks out. Non-gateway tenders are ignored — cash, and the external-terminal
 * card/upi records, have nothing here to verify.
 */
export async function verifyGatewayTenders(
  storeId: string,
  tenders: PosTender[],
): Promise<string | null> {
  for (const t of tenders) {
    if (t.method !== "razorpay") continue;

    const reference = typeof t.reference === "string" ? t.reference.trim() : "";
    if (!reference) {
      return "That online payment is missing its reference. Take it again.";
    }

    // ★ A PAYMENT SETTLES ONE TRANSACTION. `order_payments.reference` holds
    // every gateway payment this store has recorded, so re-presenting one is
    // caught here — with a message a cashier can act on, and before anything is
    // written. This is a read-then-write, so it is the courtesy, not the
    // guarantee: `order_payments_gateway_ref_key` (pos_15, applied) is what
    // holds under two tills racing (§34 invariant 3).
    try {
      const seen = await withService((db) =>
        db
          .select({ id: orderPayments.id })
          .from(orderPayments)
          .where(
            and(
              eq(orderPayments.storeId, storeId),
              eq(orderPayments.reference, reference),
              eq(orderPayments.method, "razorpay"),
            ),
          )
          .limit(1),
      );
      if (seen.length > 0) {
        return "That online payment has already been used on another sale.";
      }
    } catch (err) {
      // Cannot prove it is unused ⇒ do not accept it. The money is captured and
      // safe; completing here is the only irreversible option.
      logError("pos.tender_replay_check", err, { storeId });
      return "Couldn't check that payment. Try again.";
    }

    const verdict = await verifyCounterPayment(storeId, {
      paymentId: reference,
      expectedPaise: Math.round(t.amount * 100),
    });
    if (!verdict.ok) return verdict.error;
  }
  return null;
}
