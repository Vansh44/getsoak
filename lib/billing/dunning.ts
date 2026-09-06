import "server-only";

/**
 * Telling the merchant. The renewal worker's voice (§34).
 *
 * ★★ WITHOUT THIS THE SYSTEM IS NOT A BILLING SYSTEM. Automatic collection is
 * gated behind an unverified endpoint, so every renewal is settled by hand on
 * /dashboard/plans — and an invoice nobody is TOLD about is one nobody pays. The
 * worker would issue it silently, wait, open a 48-hour grace window silently,
 * and downgrade the store, force-closing an open POS shift, with the merchant's
 * first notice being their till refusing to sell.
 *
 * Three moments, and they are the three the merchant can act on:
 *
 *   1. INVOICE ISSUED   — "here is what's due, and when" (four days' notice)
 *   2. OVERDUE          — "pay within 48 hours or you move to Free"
 *   3. DOWNGRADED       — "this happened, here is how to come back"
 *
 * ★ EACH RIDES A CLAIM THAT ALREADY EXISTS, so none needs a `notified_at`
 * column. Issuance fires inside the `!finalizedAt` branch (an invoice is
 * finalized exactly once); overdue fires on the active→past_due UPDATE, which
 * matches once per grace window; the downgrade fires on
 * `billing_claim_downgrade()`, which is a single conditional statement. The
 * cron is an HOURLY HEARTBEAT re-reading the same rows, so without that
 * property each of these would mail the same merchant every hour — which is
 * how people learn to ignore an email (§23's pickup-reminder rule).
 *
 * ★ BEST-EFFORT, ALWAYS. Every function here swallows its own errors. A mail
 * provider being down must never fail a collection, block a cycle advance, or
 * abort a downgrade — the money and the entitlement are the real work, and the
 * notice is how we are polite about it.
 *
 * ★ EMAIL FROM HERE, IN-APP FROM THE REGISTRY. This is StoreMink billing its
 * merchant, so the mail is platform correspondence from billing@storemink.com,
 * not the store's own brand — the §24 rule that keeps `plan.changed` and
 * `subscription.payment_failed` in-app only because a dedicated sender already
 * exists. `recordEvent`, not `emitEvent`: `after()` has nothing to defer onto
 * once a cron response has been sent.
 */

import { PLAN_META, normalizePlan } from "@/lib/plans";
import { logError } from "@/lib/observability/logger";
import { recordEvent } from "@/lib/notifications/record";
import {
  manageUrl,
  planDowngradedTemplate,
  renewalDueTemplate,
  renewalOverdueTemplate,
  resolveBillingEmail,
  sendBillingEmail,
} from "@/lib/email/billing-emails";

function planName(plan: string): string {
  return PLAN_META[normalizePlan(plan)].name;
}

/**
 * An invoice has just been issued for the next cycle.
 *
 * `autopay` decides the whole message: with a mandate this is a heads-up before
 * a debit, without one it is a bill that must be paid. Sending the wrong one is
 * worse than sending neither — a merchant told "we'll collect automatically"
 * does nothing, and is downgraded.
 */
export async function notifyInvoiceIssued(input: {
  storeId: string;
  plan: string;
  amountPaise: number;
  dueAt: Date;
  invoiceRef: string | null;
  autopay: boolean;
  /**
   * What the previous cycle cost, when there was one.
   *
   * ★ Plan prices are operator-editable and renewals are priced LIVE, so a
   * merchant can be debited a different amount than last time with nothing
   * saying so. Naming the change is what keeps a reprice from arriving as a
   * surprise on a card statement.
   */
  previousAmountPaise?: number | null;
}): Promise<void> {
  try {
    const to = await resolveBillingEmail(input.storeId);
    if (!to) return;
    await sendBillingEmail(
      to.email,
      renewalDueTemplate({
        storeName: to.storeName,
        planName: planName(input.plan),
        amountInr: Math.round(input.amountPaise / 100),
        dueOn: input.dueAt.toISOString(),
        invoiceRef: input.invoiceRef,
        autopay: input.autopay,
        previousAmountInr:
          input.previousAmountPaise != null &&
          input.previousAmountPaise !== input.amountPaise
            ? Math.round(input.previousAmountPaise / 100)
            : null,
        manageUrl: manageUrl(to.slug),
      }),
      input.storeId,
    );
    await recordEvent({
      type: "subscription.invoice_due",
      storeId: input.storeId,
      subject: { type: "invoice", id: input.invoiceRef ?? undefined },
      payload: {
        amount: input.amountPaise / 100,
        currency: "INR",
        due_at: input.dueAt.toISOString(),
        reference: input.invoiceRef ?? "",
      },
    });
  } catch (err) {
    logError("billing.notify_invoice_issued", err, { storeId: input.storeId });
  }
}

/**
 * The cycle turned with the invoice unpaid — the 48-hour clock has started.
 *
 * ★ This is the LAST message that can change the outcome, so it names the
 * deadline as a date and time rather than "soon".
 */
export async function notifyGraceStarted(input: {
  storeId: string;
  plan: string;
  graceEndsAt: Date;
  autopayAttempted: boolean;
}): Promise<void> {
  try {
    const to = await resolveBillingEmail(input.storeId);
    if (!to) return;
    await sendBillingEmail(
      to.email,
      renewalOverdueTemplate({
        storeName: to.storeName,
        planName: planName(input.plan),
        accessUntil: input.graceEndsAt.toISOString(),
        // ★ Never claim an attempt that never happened. With collection gated,
        // "we couldn't take payment" is false and invites the merchant to check
        // a card that was never charged.
        attempted: input.autopayAttempted,
        manageUrl: manageUrl(to.slug),
      }),
      input.storeId,
    );
    await recordEvent({
      type: "subscription.payment_failed",
      storeId: input.storeId,
      payload: {
        plan: planName(input.plan),
        grace_ends_at: input.graceEndsAt.toISOString(),
      },
    });
  } catch (err) {
    logError("billing.notify_grace", err, { storeId: input.storeId });
  }
}

/** Grace ran out. The store is on Free and the till has stopped. */
export async function notifyDowngraded(input: {
  storeId: string;
  fromPlan: string;
}): Promise<void> {
  try {
    const to = await resolveBillingEmail(input.storeId);
    if (!to) return;
    await sendBillingEmail(
      to.email,
      planDowngradedTemplate({
        storeName: to.storeName,
        fromPlanName: planName(input.fromPlan),
        manageUrl: manageUrl(to.slug),
      }),
      input.storeId,
    );
    await recordEvent({
      type: "plan.changed",
      storeId: input.storeId,
      payload: {
        from: planName(input.fromPlan),
        to: PLAN_META.free.name,
        reason: "unpaid subscription",
      },
    });
  } catch (err) {
    logError("billing.notify_downgraded", err, { storeId: input.storeId });
  }
}
