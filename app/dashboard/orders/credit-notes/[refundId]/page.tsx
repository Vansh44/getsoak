import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { loadCreditNote } from "@/lib/billing/credit-note-data";
import { CreditNoteDocument } from "@/components/invoice/credit-note-document";
import { PrintInvoiceButton } from "@/components/invoice/print-button";

export const metadata = { title: "Credit note" };

// Keyed by REFUND, not by order: one order can be refunded more than once, and
// each settled refund is its own credit note with its own serial.
export default async function CreditNotePage({
  params,
}: {
  params: Promise<{ refundId: string }>;
}) {
  await requireSectionAccess("orders", "view");
  const { refundId } = await params;
  const data = await loadCreditNote(refundId);
  if (!data) notFound();

  return (
    <div className="invoice-wrap">
      <div className="invoice-toolbar invoice-noprint">
        <Link href="/dashboard/orders" className="invoice-back-btn">
          ← Orders
        </Link>
        {/* No print button when there is no note to print — the page explains
            why instead. */}
        {data.creditNoteRef && <PrintInvoiceButton />}
      </div>
      <CreditNoteDocument data={data} />
    </div>
  );
}
