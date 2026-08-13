import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getActingStoreId,
  requireSectionAccess,
} from "@/app/dashboard/lib/access";
import { getInvoiceDocument } from "@/lib/billing/invoice-history";
import { PrintInvoiceButton } from "@/components/invoice/print-button";
import { InvoiceSheet } from "../invoice-sheet";
// The toolbar chrome AND the `@media print` isolation that hides everything
// except `.invoice-sheet`. Reused rather than rewritten — it is generic.
import "@/components/invoice/invoice.css";

export const metadata = { title: "Invoice" };

/**
 * One StoreMink subscription invoice, printable.
 *
 * ★ `getInvoiceDocument` is scoped by STORE as well as id, so a merchant cannot
 * open another's invoice by guessing — and it returns null for a DRAFT, which is
 * not a document (no number, and it may never become one). Both surface here as
 * a plain 404 rather than a message that would confirm the id exists.
 */
export default async function SubscriptionInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSectionAccess("ai", "view");
  const { id } = await params;
  const storeId = await getActingStoreId();
  const doc = await getInvoiceDocument(storeId, id);
  if (!doc) notFound();

  return (
    <div className="invoice-wrap">
      <div className="invoice-toolbar invoice-noprint">
        <Link href="/dashboard/plans/invoices" className="invoice-back-btn">
          ← Invoices
        </Link>
        <PrintInvoiceButton />
      </div>
      <InvoiceSheet doc={doc} />
    </div>
  );
}
