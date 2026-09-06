import "server-only";

/**
 * Cancelling — and un-cancelling — a subscription (§34).
 *
 * ★★ CANCELLING IS A FLAG, NOT A GATEWAY CALL. The old path asked Razorpay to
 * cancel the Subscription, which meant it could fail for reasons that had nothing
 * to do with the merchant's intent — the commonest being _"Subscription cannot be
 * cancelled since no billing cycle is going on"_, which hit anyone cancelling
 * between authorising the mandate and the first charge and left them with no way
 * forward. Here the amount and the schedule are ours, so cancelling is
 * `cancel_at_period_end = true` and cannot fail for a provider's reasons.
 *
 * ★ THEY KEEP WHAT THEY PAID FOR. The plan runs to `current_period_end`, then
 * `evaluateCycleTurns` ends it — which is also why `claimDue` skips a cancelled
 * subscription: no invoice is raised for a cycle that will not happen, so nothing
 * can go unpaid, start a grace clock, or chase them for money.
 *
 * ★ THE MANDATE IS REVOKED IMMEDIATELY, and that is deliberate even though the
 * flag alone would stop the next charge. A live mandate is standing permission to
 * debit a card; someone who has cancelled has withdrawn it, and leaving it active
 * so that "it doesn't matter, nothing will charge it" is exactly the reasoning
 * that turns one bug into a debit.
 *
 * ★ RESUMING IS FREE, and worth having: the old flow could not offer it (the
 * gateway subscription was gone), so a merchant who changed their mind had to
 * re-authorise. Here it is clearing a flag — before the cycle ends, nothing has
 * happened yet. ⚠ It does NOT restore the mandate: that permission was withdrawn
 * and only the merchant can give it again.
 */

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { billingMandates, billingSubscriptions } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import type { SubscriptionView } from "./invoice-types";
import { AFA_EXEMPT_PAISE } from "./mandate-types";
import { notifySubscriptionCancelled } from "./receipts";

export type CancelResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** States in which there is something to cancel. */
const LIVE_STATES = ["active", "past_due", "grace"];

export interface Cancelled {
  /** When the plan actually stops. Null when no cycle was ever paid for. */
  accessUntil: string | null;
  /** True when autopay permission was withdrawn as part of this. */
  mandateRevoked: boolean;
}

/**
 * Stop future charges, keeping the plan until the paid period ends.
 *
 * ★ A CONDITIONAL CLAIM, so a double-click cancels once and a subscription that
 * moved on in between is not silently re-cancelled.
 */
export async function cancelAtPeriodEnd(input: {
  storeId: string;
  now?: Date;
}): Promise<CancelResult<Cancelled>> {
  const now = input.now ?? new Date();

  let sub:
    | {
        plan: string;
        state: string;
        currentPeriodEnd: string | null;
        cancelAtPeriodEnd: boolean;
        mandateId: string | null;
      }
    | null
    | undefined;
  try {
    sub = await withService(async (db) => {
      const [row] = await db
        .select({
          // Named so the confirmation can say WHICH plan is ending.
          plan: billingSubscriptions.plan,
          state: billingSubscriptions.state,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          mandateId: billingSubscriptions.mandateId,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, input.storeId))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.cancel.load", err, { storeId: input.storeId });
    return { ok: false, error: "Couldn't read your subscription. Try again." };
  }

  if (!sub || !LIVE_STATES.includes(sub.state)) {
    return { ok: false, error: "You don't have an active subscription." };
  }
  if (sub.cancelAtPeriodEnd) {
    return { ok: false, error: "Your subscription is already cancelling." };
  }

  let claimed = false;
  try {
    claimed = await withService(async (db) => {
      const rows = await db
        .update(billingSubscriptions)
        .set({
          cancelAtPeriodEnd: true,
          // A booked change is moot once they are leaving, and leaving it set
          // would have `resolveNextCycle` disagree with itself if they resumed.
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(billingSubscriptions.storeId, input.storeId),
            eq(billingSubscriptions.cancelAtPeriodEnd, false),
          ),
        )
        .returning({ storeId: billingSubscriptions.storeId });
      return rows.length > 0;
    });
  } catch (err) {
    logError("billing.cancel.claim", err, { storeId: input.storeId });
    return {
      ok: false,
      error: "Couldn't cancel your subscription. Try again.",
    };
  }
  if (!claimed) {
    return { ok: false, error: "Your subscription is already cancelling." };
  }

  // ★ Best-effort, and AFTER the claim. Withdrawing the standing permission is
  // the right thing to do, but failing to would not let a charge through — the
  // flag already stopped the next invoice — so it must not fail the cancel the
  // merchant asked for.
  const mandateRevoked = sub.mandateId
    ? await revokeMandate(sub.mandateId, now)
    : false;

  // ★ Confirm it. A cancellation with no acknowledgement leaves the merchant
  // unsure whether it took — and the one thing they want to know is what they
  // keep, and until when. Best-effort: the cancellation is already committed.
  await notifySubscriptionCancelled({
    storeId: input.storeId,
    plan: sub.plan,
    accessUntil: sub.currentPeriodEnd,
  });

  return {
    ok: true,
    data: { accessUntil: sub.currentPeriodEnd, mandateRevoked },
  };
}

/**
 * Change their mind, before the cycle ends.
 *
 * ⚠ Does NOT restore autopay. The mandate was revoked, and only the merchant can
 * authorise a new one — so a resumed subscription renews by manual payment until
 * they do. Saying otherwise would have them expect a charge that never comes and
 * be downgraded for it.
 */
export async function resumeSubscription(input: {
  storeId: string;
  now?: Date;
}): Promise<CancelResult<{ autopay: boolean }>> {
  const now = input.now ?? new Date();
  try {
    const rows = await withService(async (db) =>
      db
        .update(billingSubscriptions)
        .set({ cancelAtPeriodEnd: false, updatedAt: now.toISOString() })
        .where(
          and(
            eq(billingSubscriptions.storeId, input.storeId),
            eq(billingSubscriptions.cancelAtPeriodEnd, true),
            // ★ Only a subscription that has not yet ENDED can resume. Once
            // `endSubscription` has run the state is `cancelled` and the cycle is
            // gone; flipping the flag back would leave a paid state with no
            // period, which the cycle_present CHECK forbids — and would claim to
            // restore a plan that was already taken away.
            //
            // ⚠ TEST GAP: the db mock does not evaluate WHERE clauses, so
            // removing this predicate does not fail a test. The DATABASE still
            // catches the worst outcome (billing_subscriptions_cycle_present
            // rejects a paid state with no cycle), which is why the constraint is
            // the guarantee and this is the courtesy.
            eq(billingSubscriptions.state, "active"),
          ),
        )
        .returning({ mandateId: billingSubscriptions.mandateId }),
    );
    if (rows.length === 0) {
      return {
        ok: false,
        error:
          "That subscription can't be resumed. Subscribe again to start a new cycle.",
      };
    }
    // The mandate was revoked on cancel, so autopay is off until they
    // re-authorise. Reported rather than assumed.
    const autopay = await mandateIsActive(rows[0].mandateId);
    return { ok: true, data: { autopay } };
  } catch (err) {
    logError("billing.resume", err, { storeId: input.storeId });
    return {
      ok: false,
      error: "Couldn't resume your subscription. Try again.",
    };
  }
}

async function revokeMandate(mandateId: string, now: Date): Promise<boolean> {
  try {
    const rows = await withService(async (db) =>
      db
        .update(billingMandates)
        .set({ status: "revoked", updatedAt: now.toISOString() })
        .where(
          and(
            eq(billingMandates.id, mandateId),
            eq(billingMandates.status, "active"),
          ),
        )
        .returning({ id: billingMandates.id }),
    );
    return rows.length > 0;
  } catch (err) {
    logError("billing.cancel.revoke_mandate", err, { mandateId });
    return false;
  }
}

async function mandateIsActive(mandateId: string | null): Promise<boolean> {
  if (!mandateId) return false;
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ id: billingMandates.id })
        .from(billingMandates)
        .where(
          and(
            eq(billingMandates.id, mandateId),
            eq(billingMandates.status, "active"),
          ),
        )
        .limit(1);
      return !!row;
    });
  } catch {
    // Reporting "no autopay" when we cannot tell is the safe direction: the
    // merchant is told to expect a manual renewal, and a real mandate charging
    // them is a pleasant surprise rather than a missed payment.
    return false;
  }
}

/**
 * The subscription as the plans page shows it.
 *
 * ★ Returns a NEUTRAL view on a read failure rather than throwing: the page also
 * renders AI usage and the plan list, and a billing hiccup should cost the
 * subscription card, not the whole page. `active: false` hides the cancel and
 * change controls, which is the safe direction — a control that cannot work is
 * worse than an absent one.
 */
export async function getSubscriptionView(
  storeId: string,
): Promise<SubscriptionView> {
  const empty: SubscriptionView = {
    plan: null,
    period: null,
    status: null,
    currentEnd: null,
    cancelAtPeriodEnd: false,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    autopay: false,
    active: false,
  };
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          state: billingSubscriptions.state,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
          scheduledPlan: billingSubscriptions.scheduledPlan,
          scheduledPeriod: billingSubscriptions.scheduledPeriod,
          scheduledLocations: billingSubscriptions.scheduledLocations,
          mandateId: billingSubscriptions.mandateId,
          mandateStatus: billingMandates.status,
          mandateMaxPaise: billingMandates.maxAmountPaise,
        })
        .from(billingSubscriptions)
        .leftJoin(
          billingMandates,
          eq(billingMandates.id, billingSubscriptions.mandateId),
        )
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      if (!row) return empty;
      return {
        plan: row.plan,
        period: row.period === "yearly" ? "yearly" : "monthly",
        status: row.state,
        currentEnd: row.currentPeriodEnd,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        scheduledPlan: row.scheduledPlan,
        scheduledPeriod:
          row.scheduledPeriod === "yearly"
            ? "yearly"
            : row.scheduledPeriod === "monthly"
              ? "monthly"
              : null,
        scheduledLocations: row.scheduledLocations,
        // ★★ AUTOPAY MEANS THE RENEWAL WILL ACTUALLY BE TAKEN, not that a
        // mandate row exists. Read the other way, every yearly subscriber saw
        // autopay ON while `collectionRoute` sent each renewal to manual — the
        // Plans page contradicting the invoice email, and the merchant trusting
        // the reassuring one. The amount is not known here, so this answers the
        // half that IS: a live mandate whose own ceiling is inside the AFA
        // limit can carry SOME charge automatically. A ceiling above it can
        // never carry one at all, because the limit binds first.
        autopay:
          row.mandateStatus === "active" &&
          (row.mandateMaxPaise ?? 0) > 0 &&
          (row.mandateMaxPaise ?? 0) <= AFA_EXEMPT_PAISE,
        active: LIVE_STATES.includes(row.state),
      } satisfies SubscriptionView;
    });
  } catch (err) {
    logError("billing.subscription_view", err, { storeId });
    return empty;
  }
}
