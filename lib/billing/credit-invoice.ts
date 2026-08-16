import "server-only";

/**
 * Invoicing an AI credit purchase (§16 × §34).
 *
 * ★★ CREDITS GET THEIR OWN INVOICE, NEVER A LINE ON A SUBSCRIPTION ONE (spec §1,
 * §14). They are a one-off purchase at an arbitrary moment; a subscription
 * invoice covers a period and is idempotent on its cycle. `kind = 'ai_credits'`
 * carries no `cycle_seq`, which is what keeps it outside
 * `billing_invoices_one_per_cycle` and lets a merchant buy twice in a month.
 *
 * ★ THE SAME OFFER/OBLIGATION RULE AS ENROLMENT: a DRAFT at purchase time,
 * FINALIZED when the money lands. A merchant who opens the Razorpay window and
 * closes it must not burn a number in the gapless GST series for a document
 * nobody received.
 *
 * ★ EVERY FUNCTION HERE IS BEST-EFFORT and returns rather than throws. Credits
 * are granted by `add_ai_credits`, and that must not fail because an invoice
 * could not be written — a merchant who paid gets their credits, and a missing
 * document is a support question rather than lost money.
 */

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { aiCreditPurchases } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { buildAiCreditsInvoice } from "./invoice";
import {
  createAiCreditsInvoice,
  finalizePaidAiCreditsInvoice,
  loadInvoiceParties,
  loadTaxContext,
} from "./invoice-store";

/**
 * Raise the draft invoice for a purchase and link it.
 *
 * Returns the invoice id, or null when anything went wrong — the caller carries
 * on either way.
 */
export async function draftCreditInvoice(input: {
  storeId: string;
  purchaseId: string;
  packLabel: string;
  credits: number;
  amountPaise: number;
}): Promise<string | null> {
  try {
    const [tax, parties] = await Promise.all([
      loadTaxContext(input.storeId),
      loadInvoiceParties(input.storeId),
    ]);

    const built = buildAiCreditsInvoice({
      packLabel: input.packLabel,
      credits: input.credits,
      amountPaise: input.amountPaise,
      tax,
    });

    const invoice = await createAiCreditsInvoice({
      storeId: input.storeId,
      built,
      ...parties,
    });
    if (!invoice) return null;

    // ★ Linked on the PURCHASE. The unique index makes a retry a no-op rather
    // than a corruption.
    //
    // ⚠ DEPLOY ORDER: if this ships before `billing_08` is applied, the column
    // does not exist, this UPDATE throws, and the whole function returns null —
    // so credit purchases keep working and simply produce no document. What it
    // DOES leave is an orphan DRAFT invoice per purchase: harmless (drafts carry
    // no number and the history filters them out) and never finalized, but
    // untidy. Apply the migration first.
    await withService(async (db) => {
      await db
        .update(aiCreditPurchases)
        .set({ invoiceId: invoice.id })
        .where(eq(aiCreditPurchases.id, input.purchaseId));
    });
    return invoice.id;
  } catch (err) {
    logError("billing.draft_credit_invoice", err, {
      purchaseId: input.purchaseId,
    });
    return null;
  }
}

/**
 * Issue the document, now that the purchase is paid.
 *
 * ★ Called from `settlePurchase`, which is the ONE place a credit purchase
 * becomes paid — the confirm path AND the reconcile-on-read sweep both go
 * through it. Hooking only the confirm path would leave every purchase settled
 * by reconciliation without a document, which is precisely the case where the
 * merchant is already unsure what happened.
 *
 * ★ `finalizePaidAiCreditsInvoice` issues and marks the document paid in the
 * same idempotent transition. The checkout already captured this one-time
 * purchase; exposing it as an open subscription debt would invite a second
 * charge.
 */
export async function issueCreditInvoice(
  purchaseId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const invoiceId = await withService(async (db) => {
      const [row] = await db
        .select({ invoiceId: aiCreditPurchases.invoiceId })
        .from(aiCreditPurchases)
        .where(eq(aiCreditPurchases.id, purchaseId))
        .limit(1);
      return row?.invoiceId ?? null;
    });
    // ⚠ Purchases made BEFORE this existed have no draft to finalize. They stay
    // without a document rather than getting one back-dated into the current
    // financial year's series — a number issued today for a sale months ago is
    // worse than no number.
    if (!invoiceId) return;

    await finalizePaidAiCreditsInvoice(invoiceId, now);
  } catch (err) {
    logError("billing.issue_credit_invoice", err, { purchaseId });
  }
}
