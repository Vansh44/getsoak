import "server-only";

/**
 * Where the collection seam is wired to the real gateway.
 *
 * `lib/billing/collect.ts` takes a `ChargeFn` rather than importing Razorpay,
 * so everything above it is provable today. This module is the ONE place that
 * has to change when the provider call is settled — deliberately small, so
 * finishing it is obvious rather than archaeological.
 *
 * ★★ IT RETURNS NULL TODAY, AND THAT IS THE SAFE ANSWER. Six Razorpay facts are
 * still unverified (docs/billing-architecture.md §10), the exact
 * subsequent-charge endpoint among them. The alternatives are both worse:
 *
 *   • Guessing the signature would bake an unverified call into the money path
 *     and make it look tested.
 *   • Returning a stub that always fails would create payment-attempt rows that
 *     can never settle, and — because an unreachable provider is an UNKNOWN
 *     outcome, not a decline — every one of them would sit in reconciliation
 *     forever, indistinguishable from a real outage.
 *
 * Returning null instead means the renewal worker ISSUES each invoice and does
 * not charge it: no attempt rows, no phantom state, and the cron reports plainly
 * that collection is not configured. The merchant pays on /dashboard/plans,
 * which is a complete billing path on its own.
 *
 * ★ NULL MUST NOT STOP ISSUANCE. It did until 2026-08-13 — the whole pass was
 * skipped — so no invoice was ever written, nobody was ever downgraded, every
 * subscriber got free service past their cycle end, and the manual payment
 * surface had nothing to list. Issuing a document is not taking money.
 *
 * ── To finish this ────────────────────────────────────────────────────────
 *  1. Confirm the subsequent-charge endpoint and request body against a
 *     Razorpay TEST-MODE account (not the docs alone — the API reference does
 *     not reproduce the signature).
 *  2. Confirm the recurring webhook event names, and the retry and
 *     payment-failure behaviour.
 *  3. Implement the call in `rzpChargeRecurring` below, sending
 *     `idempotencyKey` BOTH as the provider's idempotency header AND inside the
 *     payment's `notes` — the notes copy is what reconciliation matches on if
 *     the header is ever unsupported or renamed, exactly as
 *     `lib/payments/issue-refund.ts` does for refunds.
 *  4. Map the provider's status through `mapGatewayStatus`, which already
 *     resolves anything unrecognised to `unknown` rather than to a failure.
 */

import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import type { ChargeFn } from "./collect";

/**
 * Has the provider call been implemented and verified?
 *
 * ⚠ Flip this ONLY once step 1 above is done against a test-mode account. It
 * gates whether any merchant is charged automatically, so it is a deliberate
 * switch rather than something that becomes true by accident.
 */
export const RECURRING_CHARGE_VERIFIED = false;

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
  return rzpChargeRecurring;
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
 * ⚠ NOT IMPLEMENTED. See the checklist above.
 *
 * It throws rather than returning a failure, because a throw is read by
 * `collectInvoice` as an UNKNOWN outcome — which is the correct reading of "we
 * do not know what happened" — and because this is unreachable while
 * `RECURRING_CHARGE_VERIFIED` is false.
 */
const rzpChargeRecurring: ChargeFn = async () => {
  throw new Error(
    "billing: recurring charge is not implemented — see lib/billing/gateway.ts",
  );
};
