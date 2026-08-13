import Link from "next/link";
import { ChevronLeft, FileText } from "lucide-react";
import { requireSectionAccess } from "../../lib/access";
import { getActingStoreId } from "../../lib/access";
import { listInvoices } from "@/lib/billing/invoice-history";

export const metadata = { title: "Invoices" };

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : "—";

/** Merchant-facing wording — `uncollectible` is our word, not theirs. */
const STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-green-50 text-green-700" },
  open: { label: "Due", cls: "bg-amber-50 text-amber-800" },
  processing: { label: "Processing", cls: "bg-blue-50 text-blue-700" },
  uncollectible: { label: "Unpaid", cls: "bg-red-50 text-red-700" },
  void: { label: "Cancelled", cls: "bg-gray-100 text-gray-600" },
};

export default async function InvoicesPage() {
  // Same section as the rest of billing. A read, so VIEW is enough.
  await requireSectionAccess("ai", "view");
  const storeId = await getActingStoreId();
  const invoices = await listInvoices(storeId);

  return (
    <div className="dash-page-enter mx-auto w-full max-w-4xl">
      <Link
        href="/dashboard/plans"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[#5b6472] hover:text-[#111827]"
      >
        <ChevronLeft className="h-4 w-4" />
        Plans &amp; Billing
      </Link>

      <h1 className="text-2xl font-bold text-[#111827]">Invoices</h1>
      <p className="mt-1 mb-6 text-sm text-[#5b6472]">
        Every subscription invoice StoreMink has issued to this store. Open one
        to print it or save it as a PDF.
      </p>

      {invoices.length === 0 ? (
        // ★ Says WHY it is empty. "No invoices" on a store that has been paying
        // reads as data loss; the real reason is almost always that they are on
        // Free, or that an invoice has not been issued yet.
        <div className="rounded-xl border border-[#e5e5e5] bg-white p-8 text-center">
          <FileText
            className="mx-auto mb-3 h-6 w-6 text-[#9aa1ab]"
            strokeWidth={1.5}
          />
          <p className="text-sm font-medium text-[#111827]">No invoices yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-[#6b7280]">
            Invoices appear here once you subscribe to a paid plan. Your first
            one is issued when you pay.
          </p>
        </div>
      ) : (
        <div className="dash-card overflow-hidden">
          <table className="dash-table w-full">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Issued</th>
                <th>Period</th>
                <th className="text-right">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const s = STATUS[inv.status] ?? {
                  label: inv.status,
                  cls: "bg-gray-100 text-gray-600",
                };
                return (
                  <tr key={inv.id}>
                    <td>
                      <Link
                        href={`/dashboard/plans/invoices/${inv.id}`}
                        className="font-mono text-sm font-medium text-[#111827] hover:underline"
                      >
                        {inv.invoiceRef ?? inv.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="text-sm text-[#5b6472]">
                      {fmtDate(inv.finalizedAt)}
                    </td>
                    <td className="text-sm text-[#5b6472]">
                      {inv.periodStart && inv.periodEnd
                        ? `${fmtDate(inv.periodStart)} — ${fmtDate(inv.periodEnd)}`
                        : "—"}
                    </td>
                    <td className="text-right text-sm font-medium text-[#111827]">
                      {inr(inv.totalPaise)}
                    </td>
                    <td>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}
                      >
                        {s.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
