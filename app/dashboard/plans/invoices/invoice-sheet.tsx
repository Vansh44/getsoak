import type { InvoiceDocument } from "@/lib/billing/invoice-types";
import "./invoice-sheet.css";
import { gstStateName, splitGstPaise } from "@/lib/billing/gst";

// ---------------------------------------------------------------------------
// A StoreMink subscription invoice, printable.
//
// ★ PRINTABLE HTML, not a server-rendered PDF — the same decision §17 made for a
// merchant's own order invoices, for the same reasons: no binary toolchain, no
// font packaging, and "Print → Save as PDF" produces a file every accountant
// accepts. `invoice.css` already isolates a sheet from all dashboard chrome.
//
// ★★ EVERY TAX FIGURE HERE COMES FROM THE INVOICE ROW, never from live settings.
// An operator turning GST on in September must not make April's invoice claim it
// charged tax. `getInvoiceDocument` does that reading; this only lays it out.
//
// ★ A NO-TAX INVOICE IS A VALID INVOICE. StoreMink has no GSTIN yet, so the GST
// block must be ABSENT rather than zeroed — a "GST ₹0" line on a document with no
// GSTIN looks like a bug, and reads like a claim.
// ---------------------------------------------------------------------------

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : "—";

function addressLines(a: {
  line1?: string;
  line2?: string;
  city?: string;
  postalCode?: string;
}): string[] {
  return [a.line1, a.line2, [a.city, a.postalCode].filter(Boolean).join(" ")]
    .map((l) => (l ?? "").trim())
    .filter(Boolean);
}

export function InvoiceSheet({ doc }: { doc: InvoiceDocument }) {
  const hasTax = doc.taxPaise > 0 && !!doc.supplierGstin;
  // Intra-state ⇒ CGST+SGST, inter-state ⇒ IGST. Split from the tax AMOUNT so it
  // can never disagree with the total's rounding (the §22 rule).
  const intra =
    !!doc.placeOfSupply &&
    !!doc.supplierGstin &&
    doc.supplierGstin.slice(0, 2) === doc.placeOfSupply;
  const split = hasTax ? splitGstPaise(doc.taxPaise, intra) : null;
  const ratePct = doc.taxRateBps ? doc.taxRateBps / 100 : 0;

  return (
    <article className="invoice-sheet">
      <header className="sminv-head">
        <div>
          <h1 className="sminv-title">{hasTax ? "Tax Invoice" : "Invoice"}</h1>
          <p className="sminv-ref">{doc.invoiceRef ?? doc.id.slice(0, 8)}</p>
        </div>
        <div className="sminv-meta">
          <Row label="Issued" value={fmtDate(doc.issuedAt)} />
          {doc.paidAt && <Row label="Paid" value={fmtDate(doc.paidAt)} />}
          {doc.periodStart && doc.periodEnd && (
            <Row
              label="Service period"
              value={`${fmtDate(doc.periodStart)} — ${fmtDate(doc.periodEnd)}`}
            />
          )}
          <Row label="Status" value={statusLabel(doc.status)} />
        </div>
      </header>

      <section className="sminv-parties">
        <div>
          <h2>From</h2>
          <p className="sminv-name">{doc.supplier.legalName}</p>
          {addressLines(doc.supplier.address).map((l) => (
            <p key={l}>{l}</p>
          ))}
          {doc.supplierGstin && <p>GSTIN: {doc.supplierGstin}</p>}
        </div>
        <div>
          <h2>Billed to</h2>
          <p className="sminv-name">{doc.customer.legalName ?? "—"}</p>
          {addressLines(doc.customer.address).map((l) => (
            <p key={l}>{l}</p>
          ))}
          {doc.customer.billingEmail && <p>{doc.customer.billingEmail}</p>}
          {doc.customerGstin && <p>GSTIN: {doc.customerGstin}</p>}
          {/* Only meaningful once tax is being charged — it is what decides
              CGST+SGST vs IGST, and on a no-tax invoice it decides nothing. */}
          {hasTax && doc.placeOfSupply && (
            <p>
              Place of supply: {gstStateName(doc.placeOfSupply)} (
              {doc.placeOfSupply})
            </p>
          )}
        </div>
      </section>

      <table className="sminv-items">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Rate</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={i}>
              <td>{it.description}</td>
              <td className="num">{it.quantity}</td>
              <td className="num">{inr(it.unitAmountPaise)}</td>
              <td className="num">{inr(it.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="sminv-totals">
        <Total label="Subtotal" value={inr(doc.subtotalPaise)} />
        {doc.discountPaise > 0 && (
          // Negative, because a bare figure reads as another charge and the
          // ladder visibly stops adding up (the §24 rule for order emails).
          <Total label="Discount" value={`−${inr(doc.discountPaise)}`} />
        )}
        {hasTax && split && (
          <>
            {intra ? (
              <>
                <Total
                  label={`CGST ${ratePct / 2}%`}
                  value={inr(split.cgstPaise)}
                />
                <Total
                  label={`SGST ${ratePct / 2}%`}
                  value={inr(split.sgstPaise)}
                />
              </>
            ) : (
              <Total label={`IGST ${ratePct}%`} value={inr(split.igstPaise)} />
            )}
          </>
        )}
        <Total label="Total" value={inr(doc.totalPaise)} strong />
      </section>

      <footer className="sminv-foot">
        {hasTax ? (
          <p>
            This is a computer-generated tax invoice and does not require a
            signature.
          </p>
        ) : (
          // ★ Says WHY there is no GST rather than leaving a gap that looks like
          // an omission — the merchant's accountant will ask.
          <p>
            No GST has been charged on this invoice. This is a
            computer-generated document and does not require a signature.
          </p>
        )}
      </footer>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="sminv-label">{label}</span>
      <span>{value}</span>
    </p>
  );
}

function Total({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <p className={strong ? "sminv-total-strong" : undefined}>
      <span>{label}</span>
      <span>{value}</span>
    </p>
  );
}

/** Merchant-facing wording. `uncollectible` is our word, not theirs. */
function statusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "open":
      return "Due";
    case "processing":
      return "Payment in progress";
    case "uncollectible":
      return "Unpaid — plan ended";
    case "void":
      return "Cancelled";
    default:
      return status;
  }
}
