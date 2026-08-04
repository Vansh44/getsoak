// How much store credit to put against an order (roadmap Step 4 /
// returns-exchanges-plan Step 7).
//
// PURE. Small, but it decides what a customer is charged, and it has one edge
// case that is invisible until it happens in production.

import { toPaise, toRupees } from "@/lib/payments/refunds";

/** Razorpay refuses anything under ₹1. Passing 0 disables the rule — COD and
 *  the till have no floor, because nobody is calling a gateway. */
export const GATEWAY_MINIMUM = 1;

export interface CreditApplication {
  /** Credit to deduct. Never more than the balance or the total. */
  applied: number;
  /** What still has to be paid by other means. */
  remaining: number;
  /** Credit covers the lot — there is nothing to charge, so no gateway call
   *  and no cash to collect. */
  coversAll: boolean;
  /** True when `applied` was REDUCED to keep `remaining` payable. */
  heldBackForMinimum: boolean;
}

/**
 * Split an order total between store credit and everything else.
 *
 * ★ THE EDGE CASE: a remainder below the gateway's minimum is unpayable.
 *
 * A ₹200.50 order against a ₹200 balance naively leaves ₹0.50 to charge —
 * and Razorpay rejects anything under ₹1, so checkout would fail with an error
 * about the amount being too small, on an order the customer had almost
 * enough credit for. That is a maddening thing to hit and an easy thing to
 * miss, because it only appears when the balance lands within a rupee of the
 * total.
 *
 * So when the remainder would fall in that gap, LESS credit is applied — just
 * enough to leave a chargeable amount. Holding back a few paise of credit is
 * strictly better than a checkout that can't complete, and the credit isn't
 * lost: it stays on the balance.
 *
 * The other direction — rounding the credit UP to cover the whole order — was
 * rejected: it spends money the customer didn't agree to spend, to save them a
 * rupee they were willing to pay.
 */
export function creditToApply(input: {
  orderTotal: number;
  balance: number;
  /** Set 0 for COD / counter payments, which have no floor. */
  gatewayMinimum?: number;
}): CreditApplication {
  const totalP = Math.max(0, toPaise(input.orderTotal));
  const balanceP = Math.max(0, toPaise(input.balance));
  const minP = Math.max(0, toPaise(input.gatewayMinimum ?? GATEWAY_MINIMUM));

  if (totalP <= 0 || balanceP <= 0) {
    return {
      applied: 0,
      remaining: toRupees(totalP),
      coversAll: false,
      heldBackForMinimum: false,
    };
  }

  // Credit never exceeds what is owed — an over-application would be cash back
  // through the side door.
  let appliedP = Math.min(balanceP, totalP);
  let remainingP = totalP - appliedP;
  let heldBack = false;

  if (remainingP > 0 && remainingP < minP) {
    // Leave exactly the minimum to charge, if the total is big enough for
    // that to make sense. When it isn't (a total below the minimum itself),
    // credit simply covers the whole thing.
    if (totalP >= minP) {
      appliedP = totalP - minP;
      remainingP = minP;
      heldBack = true;
    } else {
      appliedP = totalP;
      remainingP = 0;
    }
  }

  return {
    applied: toRupees(appliedP),
    remaining: toRupees(remainingP),
    coversAll: remainingP === 0 && appliedP > 0,
    heldBackForMinimum: heldBack,
  };
}
