// ---------------------------------------------------------------------------
// When a plan change takes effect — the rule, on its own, so it can be tested
// without a gateway.
//
// THE RULE: money decides, not the merchant.
//
//   dearer than what they pay now  → immediately, Razorpay prorates the
//                                    difference and charges it
//   cheaper, or the same           → at the end of the paid cycle
//
// This is what Shopify does, and the reason is the second half: a downgrade
// applied immediately means refunding the unused part of something already
// paid for. Razorpay will do that (it issues a credit note automatically), but
// refunds are the messiest thing in billing — disputes, partial reversals,
// reconciliation — and waiting for the cycle to end removes the entire class of
// problem. Nobody loses money either way; they just keep what they bought until
// it runs out.
//
// It is deliberately NOT the merchant's choice. "Apply now" on a downgrade
// looks like the helpful option and is the one that triggers a refund.
//
// AMOUNTS, NOT TIERS. Comparing rank would get monthly→yearly wrong (same tier,
// much larger charge) and would also ignore that an existing subscriber may be
// grandfathered on an older, cheaper price — in which case a "downgrade" by
// tier can still be an increase on what they actually pay today.
// ---------------------------------------------------------------------------

export type BillingPeriod = "monthly" | "yearly";

export interface PlanChangeRequest {
  currentPlan: string;
  currentPeriod: BillingPeriod;
  /** What they are charged TODAY, in paise. May be a grandfathered price. */
  currentAmountPaise: number;
  targetPlan: string;
  targetPeriod: BillingPeriod;
  /** What the target costs at today's catalog price, in paise. */
  targetAmountPaise: number;
}

export type PlanChangeDecision =
  | { kind: "noop"; reason: string }
  | {
      kind: "change";
      /** Razorpay's schedule_change_at. */
      when: "now" | "cycle_end";
      /** True when the merchant will be charged the difference now. */
      immediate: boolean;
      /** Did the billing period change as well as (or instead of) the tier? */
      periodChanged: boolean;
      planChanged: boolean;
    };

/**
 * Razorpay refuses to update a subscription outside these states, so we must
 * too — otherwise the merchant gets a raw gateway error at exactly the moment
 * they are trying to fix a billing problem.
 *
 * `halted` and `pending` are the states a subscription lands in AFTER failed
 * payments, which is precisely when someone comes here to downgrade.
 */
export const UPDATABLE_STATES = new Set(["authenticated", "active"]);

export function canUpdateSubscription(status: string | null | undefined): {
  ok: boolean;
  reason?: string;
} {
  const s = (status ?? "").toLowerCase();
  if (UPDATABLE_STATES.has(s)) return { ok: true };
  if (s === "halted" || s === "pending") {
    return {
      ok: false,
      reason:
        "Your last payment didn't go through, so the plan can't be changed yet. Update your payment method first — once a charge succeeds you can switch plans.",
    };
  }
  if (s === "cancelled" || s === "completed" || s === "expired") {
    return { ok: false, reason: "No active subscription to change." };
  }
  return {
    ok: false,
    reason:
      "Your subscription is still being set up. Try again in a few moments.",
  };
}

// ---------------------------------------------------------------------------
// Does an authorised mandate exist?
//
// An ALLOWLIST, not "everything that isn't terminal". `created` is the state
// that matters: the subscription object is made at Razorpay BEFORE the merchant
// is shown the mandate screen, so anyone who opens the upgrade modal and closes
// it leaves a `created` row behind permanently. Counting that as live made the
// billing card claim a store had autopay it had never authorised, offer to
// cancel it (which the gateway refused), and — because the same flag routes the
// upgrade modal through changePlan, which Razorpay only allows on
// authenticated/active — quietly disable every later upgrade attempt.
//
// As an allowlist, an unknown or newly-added gateway state reads as "no
// mandate", which shows a Subscribe button rather than controls that error.
// ---------------------------------------------------------------------------
const LIVE_MANDATE = new Set(["authenticated", "active", "pending", "halted"]);

export function hasLiveMandate(status: string | null | undefined): boolean {
  return LIVE_MANDATE.has((status ?? "").toLowerCase());
}

/**
 * Whether a cancellation should take effect at the end of the paid cycle
 * (`cancel_at_cycle_end`) rather than immediately.
 *
 * Razorpay REFUSES a cycle-end cancel when no cycle is running —
 * "Subscription cannot be cancelled since no billing cycle is going on" — and a
 * cycle only starts at the first successful charge. So this is false between
 * authorising a mandate and being billed on it, where cancelling immediately
 * takes nothing away: nothing has been paid for yet.
 */
export function cancelsAtCycleEnd(
  status: string | null | undefined,
  currentEnd: string | null | undefined,
): boolean {
  return (status ?? "").toLowerCase() === "active" && !!currentEnd;
}

export function decidePlanChange(req: PlanChangeRequest): PlanChangeDecision {
  const planChanged = req.currentPlan !== req.targetPlan;
  const periodChanged = req.currentPeriod !== req.targetPeriod;

  if (!planChanged && !periodChanged) {
    return { kind: "noop", reason: "You're already on this plan." };
  }

  // Strictly dearer is the only case that applies immediately. Equal amounts
  // (a like-for-like move) wait too — there is nothing to gain by charging a
  // proration of zero, and Razorpay rejects immediate updates whose prorated
  // difference is under ₹0.50 anyway.
  const immediate = req.targetAmountPaise > req.currentAmountPaise;

  return {
    kind: "change",
    when: immediate ? "now" : "cycle_end",
    immediate,
    periodChanged,
    planChanged,
  };
}

/** What to tell the merchant BEFORE they confirm. */
export function describePlanChange(
  d: Extract<PlanChangeDecision, { kind: "change" }>,
  targetName: string,
  targetPeriod: BillingPeriod,
): string {
  const what =
    d.periodChanged && !d.planChanged
      ? `${targetName} billed ${targetPeriod}`
      : d.periodChanged
        ? `${targetName}, billed ${targetPeriod}`
        : targetName;

  return d.immediate
    ? `You'll move to ${what} now. You'll be charged the difference for the rest of this cycle.`
    : `You'll stay on your current plan until it runs out, then move to ${what}. Nothing is charged today.`;
}
