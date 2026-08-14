import "server-only";

/**
 * Telling the merchant that something GOOD happened (§34).
 *
 * ★★ SEPARATE FROM `dunning.ts` ON PURPOSE. Dunning means debt collection — the
 * invoice issued, the 48-hour warning, the downgrade. These three are
 * acknowledgements: your plan is on, we got your money, your cancellation is
 * recorded. Same machinery, opposite job, and a module that holds both ends up
 * called "billing-emails-2" within a year.
 *
 * ★★ ALL THREE ARE REGRESSIONS BEING REPAIRED, not new features. The old
 * Razorpay-Subscriptions path sent every one of them — `planActivatedTemplate`
 * from `confirmSubscription`, `paymentReceiptTemplate` and
 * `subscriptionCancelledTemplate` from the webhook — and deleting that path on
 * 2026-08-13 took them with it. For a few days a merchant could subscribe, pay
 * ₹50,000 and hear nothing at all, which is worse than the old system.
 *
 * ★ BEST-EFFORT, ALWAYS. These are called after money has moved and state has
 * been committed. A mail provider having a bad afternoon must never fail a
 * payment, a cancellation, or an activation.
 */

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { billingInvoices, billingSubscriptions } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { PLAN_META, normalizePlan } from "@/lib/plans";
import {
  manageUrl,
  paymentReceiptTemplate,
  planActivatedTemplate,
  resolveBillingEmail,
  sendBillingEmail,
  subscriptionCancelledTemplate,
} from "@/lib/email/billing-emails";

function planName(plan: string): string {
  return PLAN_META[normalizePlan(plan)].name;
}

/**
 * An invoice has just been paid.
 *
 * ★★ CALLED FROM `settleAttempt`, the ONE place an invoice transitions to paid —
 * so enrolment, manual payment, a plan change, a location purchase AND
 * reconciliation each produce exactly one receipt, and none of them has to
 * remember to. The transition is claimed, so a second settle sends nothing.
 */
export async function notifyInvoicePaid(
  storeId: string,
  invoiceId: string,
): Promise<void> {
  try {
    const [to, invoice] = await Promise.all([
      resolveBillingEmail(storeId),
      loadInvoice(storeId, invoiceId),
    ]);
    if (!to || !invoice) return;

    // ★ A credit purchase is not a subscription payment, and a receipt saying
    // "your Pro plan is active" for a ₹59 credit pack is wrong. Those have their
    // own confirmation (`ai.credits_purchased`), so this stays quiet.
    if (invoice.kind === "ai_credits") return;

    const sub = await loadSubscription(storeId);
    await sendBillingEmail(
      to.email,
      paymentReceiptTemplate({
        storeName: to.storeName,
        planName: planName(sub?.plan ?? "basic"),
        amountInr: Math.round(invoice.totalPaise / 100),
        period: sub?.period === "yearly" ? "yearly" : "monthly",
        // The date the merchant cares about is when it runs to, not when we
        // wrote the row.
        renewsOn: invoice.periodEnd ?? sub?.currentPeriodEnd ?? null,
        manageUrl: manageUrl(to.slug),
      }),
      storeId,
    );
  } catch (err) {
    logError("billing.notify_invoice_paid", err, { storeId, invoiceId });
  }
}

/**
 * A merchant has just subscribed.
 *
 * ★ `autopay` decides what the email PROMISES. Saying "it renews automatically"
 * to someone with no mandate is how a merchant does nothing and is downgraded —
 * the same rule the invoice-issued notice follows.
 */
export async function notifyPlanActivated(input: {
  storeId: string;
  /** What they just paid — the amount comes from the document, not the caller. */
  invoiceId: string;
  autopay: boolean;
}): Promise<void> {
  try {
    const [to, invoice, sub] = await Promise.all([
      resolveBillingEmail(input.storeId),
      loadInvoice(input.storeId, input.invoiceId),
      loadSubscription(input.storeId),
    ]);
    if (!to || !sub) return;
    await sendBillingEmail(
      to.email,
      planActivatedTemplate({
        storeName: to.storeName,
        planName: planName(sub.plan),
        amountInr: Math.round((invoice?.totalPaise ?? 0) / 100),
        period: sub.period === "yearly" ? "yearly" : "monthly",
        // ⚠ The template's copy says autopay is set up. With no mandate that is
        // untrue, so the renewal date is withheld rather than promised — the
        // merchant is told when to expect an invoice by the dunning notice
        // instead.
        renewsOn: input.autopay ? sub.currentPeriodEnd : null,
        manageUrl: manageUrl(to.slug),
      }),
      input.storeId,
    );
  } catch (err) {
    logError("billing.notify_plan_activated", err, { storeId: input.storeId });
  }
}

/** A subscription has been cancelled — confirmed, with what they keep and until when. */
export async function notifySubscriptionCancelled(input: {
  storeId: string;
  plan: string;
  accessUntil: string | null;
}): Promise<void> {
  try {
    const to = await resolveBillingEmail(input.storeId);
    if (!to) return;
    await sendBillingEmail(
      to.email,
      subscriptionCancelledTemplate({
        storeName: to.storeName,
        planName: planName(input.plan),
        accessUntil: input.accessUntil,
        manageUrl: manageUrl(to.slug),
      }),
      input.storeId,
    );
  } catch (err) {
    logError("billing.notify_cancelled", err, { storeId: input.storeId });
  }
}

async function loadInvoice(storeId: string, invoiceId: string) {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          kind: billingInvoices.kind,
          totalPaise: billingInvoices.totalPaise,
          periodEnd: billingInvoices.periodEnd,
        })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, invoiceId),
            // Scoped, like every other invoice read.
            eq(billingInvoices.storeId, storeId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
  } catch {
    return null;
  }
}

async function loadSubscription(storeId: string) {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          plan: billingSubscriptions.plan,
          period: billingSubscriptions.period,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);
      return row ?? null;
    });
  } catch {
    return null;
  }
}
