import "server-only";

/**
 * A merchant's own subscription invoices — the list, and one document (§34).
 *
 * ★★ WHY THIS HAD TO EXIST. The gapless per-FY invoice series, the immutability
 * triggers and the tax snapshot all exist to produce a document a merchant can
 * put in front of their accountant. Until now nothing could retrieve one: the
 * only reader was `listPayableInvoices`, which shows what is OWED. A merchant who
 * had paid ₹50,000 for a year had no receipt.
 *
 * ★ ONLY FINALIZED INVOICES ARE DOCUMENTS. A `draft` has no number — the trigger
 * allocates one on finalize precisely so an abandoned checkout does not burn one
 * — so a draft is not a thing a merchant can be shown or asked about. Enrolment
 * and add-on purchases both leave drafts behind when the payment window is
 * closed, and those must stay invisible.
 *
 * ★ EVERY READ IS SCOPED BY STORE as well as by id. An invoice id alone must
 * never reach across tenants — not to view, not to learn an amount.
 */

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingAccounts,
  billingInvoiceItems,
  billingInvoices,
  platformBillingSettings,
} from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import type { InvoiceDocument, InvoiceSummary } from "./invoice-types";

/** Statuses that mean "this is a real, issued document". */
const ISSUED = ["open", "processing", "paid", "uncollectible", "void"];

/**
 * The merchant's issued invoices, newest first.
 *
 * Returns [] on a read failure — the page shows "no invoices yet", which is
 * wrong but harmless, where throwing would take down a page that also carries
 * their plan and their AI usage.
 */
export async function listInvoices(
  storeId: string,
  limit = 50,
): Promise<InvoiceSummary[]> {
  try {
    return await withService(async (db) =>
      db
        .select({
          id: billingInvoices.id,
          invoiceRef: billingInvoices.invoiceRef,
          kind: billingInvoices.kind,
          status: billingInvoices.status,
          totalPaise: billingInvoices.totalPaise,
          periodStart: billingInvoices.periodStart,
          periodEnd: billingInvoices.periodEnd,
          finalizedAt: billingInvoices.finalizedAt,
          paidAt: billingInvoices.paidAt,
        })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            // ★ A finalized invoice always has a ref (the trigger allocates one),
            // so this is belt and braces on the status filter — and it is what
            // guarantees every row in the list can be linked to.
            isNotNull(billingInvoices.finalizedAt),
          ),
        )
        .orderBy(desc(billingInvoices.finalizedAt))
        .limit(limit),
    );
  } catch (err) {
    logError("billing.list_invoices", err, { storeId });
    return [];
  }
}

/**
 * One invoice, rendered from its OWN snapshot.
 *
 * ★★ THE TAX FIGURES AND IDENTIFIERS COME FROM THE INVOICE ROW, never from live
 * settings. That is the whole point of stamping them: an operator turning GST on,
 * changing the rate or correcting a GSTIN in September must not rewrite what
 * April's invoice says it charged.
 *
 * ⚠ THE NAMES AND ADDRESSES ARE READ LIVE, because no column stores them. A
 * rename would restate the label on an old invoice — not the amounts, the rate,
 * the GSTINs or the document number. Closing that needs a `parties jsonb` column;
 * it is recorded here rather than left to be discovered.
 */
export async function getInvoiceDocument(
  storeId: string,
  invoiceId: string,
): Promise<InvoiceDocument | null> {
  try {
    return await withService(async (db) => {
      const [inv] = await db
        .select()
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, invoiceId),
            // Scoped by store: an id alone must never cross tenants.
            eq(billingInvoices.storeId, storeId),
          ),
        )
        .limit(1);
      // A draft is not a document — no number, and it may never become one.
      if (!inv || !inv.finalizedAt || !ISSUED.includes(inv.status)) return null;

      const [items, [supplier], [customer]] = await Promise.all([
        db
          .select({
            kind: billingInvoiceItems.kind,
            description: billingInvoiceItems.description,
            quantity: billingInvoiceItems.quantity,
            unitAmountPaise: billingInvoiceItems.unitAmountPaise,
            amountPaise: billingInvoiceItems.amountPaise,
          })
          .from(billingInvoiceItems)
          .where(eq(billingInvoiceItems.invoiceId, inv.id))
          .orderBy(billingInvoiceItems.sortOrder),
        db
          .select({
            legalName: platformBillingSettings.legalName,
            address: platformBillingSettings.address,
          })
          .from(platformBillingSettings)
          .limit(1),
        db
          .select({
            legalName: billingAccounts.legalName,
            address: billingAccounts.address,
            billingEmail: billingAccounts.billingEmail,
          })
          .from(billingAccounts)
          .where(eq(billingAccounts.storeId, storeId))
          .limit(1),
      ]);

      return {
        id: inv.id,
        invoiceRef: inv.invoiceRef,
        kind: inv.kind,
        status: inv.status,
        issuedAt: inv.finalizedAt,
        paidAt: inv.paidAt,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        subtotalPaise: inv.subtotalPaise,
        discountPaise: inv.discountPaise,
        taxPaise: inv.taxPaise,
        totalPaise: inv.totalPaise,
        // ★ From the ROW. See the note above.
        taxRateBps: inv.taxRateBps,
        supplierGstin: inv.supplierGstin,
        customerGstin: inv.customerGstin,
        placeOfSupply: inv.placeOfSupply,
        items,
        supplier: {
          legalName: supplier?.legalName ?? "StoreMink",
          address: (supplier?.address ??
            {}) as InvoiceDocument["supplier"]["address"],
        },
        customer: {
          legalName: customer?.legalName ?? null,
          address: (customer?.address ??
            {}) as InvoiceDocument["customer"]["address"],
          billingEmail: customer?.billingEmail ?? null,
        },
      };
    });
  } catch (err) {
    logError("billing.get_invoice_document", err, { storeId, invoiceId });
    return null;
  }
}
