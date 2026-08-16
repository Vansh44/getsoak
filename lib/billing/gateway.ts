import "server-only";

/**
 * Where the collection seam is wired to the real gateway.
 *
 * `lib/billing/collect.ts` takes a `ChargeFn` rather than importing Razorpay,
 * so everything above it is provable independently. This is the ONE
 * provider-specific seam.
 *
 * ★★ AUTOMATIC COLLECTION IS ENABLED for the staging / empty-production
 * verification rollout. `getRecurringCharge` still returns null when platform
 * credentials are absent, so invoice issuance always retains its manual path.
 *
 *   • Guessing the signature would bake an unverified call into the money path
 *     and make it look tested.
 *   • Returning a stub that always fails would create payment-attempt rows that
 *     can never settle, and — because an unreachable provider is an UNKNOWN
 *     outcome, not a decline — every one of them would sit in reconciliation
 *     forever, indistinguishable from a real outage.
 *
 * Returning null when credentials are unavailable means the renewal worker
 * ISSUES each invoice and does not charge it: no attempt rows, no phantom state,
 * and the merchant pays on /dashboard/plans, a complete billing path on its own.
 *
 * ★ NULL MUST NOT STOP ISSUANCE. It did until 2026-08-13 — the whole pass was
 * skipped — so no invoice was ever written, nobody was ever downgraded, every
 * subscriber got free service past their cycle end, and the manual payment
 * surface had nothing to list. Issuing a document is not taking money.
 *
 * ── Verification rollout ─────────────────────────────────────────────────
 *  1. Confirm the subsequent-charge endpoint and request body against a
 *     Razorpay TEST-MODE account (not the docs alone — the API reference does
 *     not reproduce the signature).
 *  2. Confirm the recurring webhook event names, and the retry and
 *     payment-failure behaviour.
 *  3. Confirm whether the recurring endpoint offers provider-side idempotency.
 *     Its published reference does not promise a header, so today the durable
 *     attempt, write-once provider order id and payment `notes` are the guard.
 *  4. Confirm the provider's status vocabulary through `mapGatewayStatus`, which
 *     resolves anything unrecognised to `unknown` rather than to a failure.
 */

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins } from "@/drizzle/schema";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import { rzpChargeMandate, rzpCreateOrder } from "@/lib/payments/razorpay";
import type { ChargeFn } from "./collect";

/**
 * Has the provider call been implemented and verified?
 *
 * Enabled 2026-08-16 at the owner's request for test-mode staging and an empty
 * production account. Keep the verification runbook open while exercising the
 * first mandate and debit; set this back to false immediately if an observed
 * provider shape differs from the contract tests.
 */
export const RECURRING_CHARGE_VERIFIED = true;

/**
 * The production charge function, or null when automatic collection cannot
 * safely run.
 *
 * Null for either reason — no platform credentials, or an unverified endpoint —
 * because from the worker's point of view they are the same thing: there is no
 * way to take money right now, so it must not pretend to try.
 */
export function getRecurringCharge(): ChargeFn | null {
  if (!RECURRING_CHARGE_VERIFIED) return null;
  const creds = getPlatformRazorpayCreds();
  if (!creds) return null;
  return chargeMandateViaRazorpay;
}

/** Why collection is unavailable, for the cron's response. */
export function chargeUnavailableReason(): string | null {
  if (!RECURRING_CHARGE_VERIFIED) {
    return "recurring charge endpoint not yet verified against a test-mode account";
  }
  if (!getPlatformRazorpayCreds()) {
    return "platform Razorpay credentials are not configured";
  }
  return null;
}

/**
 * Charge an existing mandate.
 *
 * ★★ TWO CALLS, NOT ONE. `POST /payments/create/recurring` takes an `order_id`,
 * so an order has to be created first. That makes the gap between them the
 * dangerous part: an order created and a charge we never got an answer to is
 * indistinguishable from a charge that succeeded. Every failure below is
 * therefore mapped deliberately, and the DEFAULT is `unknown` — never `failed`.
 *
 * ★ The attempt's idempotency key rides in `notes`. Unlike refunds, Razorpay's
 * published recurring-payment reference does not specify an idempotency header.
 * The write-once provider order id is persisted BEFORE the debit call so an
 * unknown outcome can be reconciled without sending the charge again.
 *
 * ⚠ Razorpay documents that for some banks the payment stays `created` rather
 * than reaching `captured` immediately. `mapGatewayStatus` resolves that to a
 * non-terminal state, so reconciliation settles it later instead of the worker
 * reading it as a decline and opening a grace window.
 */
// ★ Exported so it can be tested directly. `getRecurringCharge` is the only
// production caller and it stays gated on RECURRING_CHARGE_VERIFIED — shipping
// an untested charge path because the flag hides it is how the flag ends up
// being the only thing anyone trusts. This is a `lib/` module, not a
// "use server" file, so an export here is not a public endpoint.
export const chargeMandateViaRazorpay: ChargeFn = async (input) => {
  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return {
      ok: false,
      error: "Platform Razorpay credentials are not configured.",
      outcome: "rejected",
    };
  }
  if (!input.providerCustomerId) {
    // A token with no customer cannot be charged. Rejected rather than unknown:
    // nothing was sent, so nothing can have happened.
    return {
      ok: false,
      error: "This mandate has no Razorpay customer attached.",
      outcome: "rejected",
    };
  }

  const contact = await resolveBillingContact(input.storeId);
  if (!contact) {
    return {
      ok: false,
      error: "No billing contact to charge against.",
      outcome: "rejected",
    };
  }

  // ── 1. The order ─────────────────────────────────────────────────────────
  const order = await rzpCreateOrder(creds, {
    amountPaise: input.amountPaise,
    receipt: input.idempotencyKey.slice(0, 40),
    notes: { idempotency_key: input.idempotencyKey, kind: "subscription" },
  });
  if (!order.ok) {
    // No debit was attempted: the recurring endpoint needs the order id, which
    // we did not receive. Even if Razorpay created an orphan order, money cannot
    // move on it, so this is a known non-charge and a later attempt is safe.
    return { ok: false, error: order.error, outcome: "rejected" };
  }

  // ★★ DURABLE BEFORE DEBIT. If the charge times out after this point,
  // reconciliation can ask Razorpay for payments on this exact order. Charging
  // first and trying to save the id afterwards creates an unrecoverable gap.
  if (!(await input.recordProviderOrderId(order.data.id))) {
    return {
      ok: false,
      error: "Couldn't record the Razorpay order before charging it.",
      outcome: "rejected",
    };
  }

  // ── 2. The charge ────────────────────────────────────────────────────────
  const paid = await rzpChargeMandate(creds, {
    amountPaise: input.amountPaise,
    orderId: order.data.id,
    customerId: input.providerCustomerId,
    tokenId: input.providerTokenId,
    email: contact.email,
    contact: contact.phone,
    description: input.description,
    notes: { idempotency_key: input.idempotencyKey },
  });
  if (!paid.ok) return paid;

  const paymentId = paid.data.razorpay_payment_id;
  if (!paymentId) {
    // ★ A 200 with no payment id is NOT a success we can record and NOT a
    // failure we can act on — we have an order at the gateway and no way to
    // name what happened to it. Reconciliation asks Razorpay directly.
    return {
      ok: false,
      error: "Razorpay accepted the charge without returning a payment id.",
      outcome: "unknown",
    };
  }

  return {
    ok: true,
    data: {
      providerPaymentId: paymentId,
      // Absent status means "created" — the file-based-charging case above —
      // which maps to a non-terminal state rather than to captured.
      status: paid.data.status ?? "created",
    },
  };
};

/**
 * The email and phone Razorpay requires on a recurring charge.
 *
 * Both are MANDATORY per the API reference. A store with neither cannot be
 * charged automatically, which the caller reports as a rejection rather than
 * guessing at a placeholder — a charge filed against the wrong contact is worse
 * than one that did not happen.
 */
async function resolveBillingContact(
  storeId: string,
): Promise<{ email: string; phone: string } | null> {
  try {
    const [row] = await withService((db) =>
      db
        .select({ email: admins.email, phone: admins.phone })
        .from(admins)
        .where(and(eq(admins.storeId, storeId), eq(admins.role, "superadmin")))
        .limit(1),
    );
    if (!row?.email || !row.phone) return null;
    return { email: row.email, phone: row.phone };
  } catch {
    return null;
  }
}
