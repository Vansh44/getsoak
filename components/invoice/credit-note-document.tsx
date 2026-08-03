import { formatPrice } from "@/lib/pricing";
import type { CreditNoteData } from "@/lib/billing/credit-note-data";
import "./invoice.css";

// A GST credit note (roadmap Step 6).
//
// Deliberately reuses the invoice's stylesheet and layout: the two documents
// go in the same folder, get filed together, and a merchant printing one after
// the other should not be able to tell they were built by different people.
// What differs is what it SAYS, not how it looks.
//
// ★ The three things that make this a credit note rather than a refund
// receipt, all required for it to be worth anything to a CA:
//   1. its OWN serial (CRN…), consecutive with no gaps
//   2. the invoice it reverses, named explicitly
//   3. the tax split the same way it was charged — CGST+SGST or IGST

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formatAddress(a: Record<string, unknown> | null): {
  name: string;
  lines: string[];
} {
  if (!a) return { name: "", lines: [] };
  const g = (k: string) => str(a[k]);
  return {
    name: [g("firstName"), g("lastName")].filter(Boolean).join(" "),
    lines: [
      g("addressLine1") || g("address"),
      g("addressLine2"),
      [g("city"), g("state"), g("postalCode") || g("pincode")]
        .filter(Boolean)
        .join(", "),
      g("country"),
    ].filter(Boolean),
  };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });
}

export function CreditNoteDocument({ data }: { data: CreditNoteData }) {
  const { billing } = data;
  const to = formatAddress(data.billTo);

  // No serial = no document. Say why rather than printing a blank one that
  // looks like a bug and gets filed anyway.
  if (!data.creditNoteRef) {
    return (
      <div className="invoice-sheet">
        <div className="inv-head">
          <div>
            <div className="inv-biz-name">
              {billing.businessName || "Credit note"}
            </div>
          </div>
        </div>
        <p style={{ marginTop: 24, fontSize: 14, lineHeight: 1.6 }}>
          {data.missingReason ??
            "No credit note has been raised for this refund."}
        </p>
      </div>
    );
  }

  return (
    <div className="invoice-sheet">
      <div className="inv-head">
        <div>
          <div className="inv-biz-name">{billing.businessName || "Store"}</div>
          <div className="inv-biz-meta">
            {billing.businessAddress && <div>{billing.businessAddress}</div>}
            {billing.taxId && <div>GSTIN: {billing.taxId}</div>}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="inv-title">Credit Note</div>
          <div className="inv-meta-row">
            <span>No.</span>
            <strong>{data.creditNoteRef}</strong>
          </div>
          <div className="inv-meta-row">
            <span>Date</span>
            <strong>{fmtDate(data.creditNoteAt)}</strong>
          </div>
          {/* ★ The invoice being reversed. A credit note that doesn't name one
              reverses nothing. */}
          <div className="inv-meta-row">
            <span>Against invoice</span>
            <strong>{data.orderRef ?? "—"}</strong>
          </div>
          <div className="inv-meta-row">
            <span>Invoice date</span>
            <strong>{fmtDate(data.orderDate)}</strong>
          </div>
        </div>
      </div>

      <div className="inv-parties">
        <div>
          <div className="inv-party-label">Credit to</div>
          <div className="inv-party-body">
            {to.name && <div>{to.name}</div>}
            {to.lines.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
        <div>
          <div className="inv-party-label">Place of supply</div>
          <div className="inv-party-body">
            <div>{data.placeOfSupplyState || "—"}</div>
            <div>{data.intraState ? "Intra-state" : "Inter-state"}</div>
          </div>
        </div>
      </div>

      <table className="inv-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>HSN</th>
            <th style={{ textAlign: "right" }}>Qty</th>
            <th style={{ textAlign: "right" }}>Value</th>
            <th style={{ textAlign: "right" }}>Rate</th>
            {data.intraState ? (
              <>
                <th style={{ textAlign: "right" }}>CGST</th>
                <th style={{ textAlign: "right" }}>SGST</th>
              </>
            ) : (
              <th style={{ textAlign: "right" }}>IGST</th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <div className="inv-item-name">{l.name}</div>
                {l.variantName && (
                  <div className="inv-item-variant">{l.variantName}</div>
                )}
              </td>
              <td>{l.hsnCode || "—"}</td>
              <td style={{ textAlign: "right" }}>{l.quantity}</td>
              <td style={{ textAlign: "right" }}>{formatPrice(l.amount)}</td>
              <td style={{ textAlign: "right" }}>{l.taxRate}%</td>
              {data.intraState ? (
                <>
                  <td style={{ textAlign: "right" }}>
                    {formatPrice(l.gst.cgst)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {formatPrice(l.gst.sgst)}
                  </td>
                </>
              ) : (
                <td style={{ textAlign: "right" }}>
                  {formatPrice(l.gst.igst)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inv-totals">
        <div className="inv-totals-inner">
          <div className="inv-total-row">
            <span>Taxable value credited</span>
            <span>{formatPrice(data.subtotal)}</span>
          </div>
          {data.intraState ? (
            <>
              <div className="inv-total-row">
                <span>CGST</span>
                <span>{formatPrice(data.gst.cgst)}</span>
              </div>
              <div className="inv-total-row">
                <span>SGST</span>
                <span>{formatPrice(data.gst.sgst)}</span>
              </div>
            </>
          ) : (
            <div className="inv-total-row">
              <span>IGST</span>
              <span>{formatPrice(data.gst.igst)}</span>
            </div>
          )}
          {/* Shown because otherwise the refund not matching the credited
              value is an unexplained discrepancy on a legal document. */}
          {data.feesWithheld > 0 && (
            <div className="inv-total-row">
              <span>Less fees retained</span>
              <span>−{formatPrice(data.feesWithheld)}</span>
            </div>
          )}
          <div className="inv-total-row inv-total-grand">
            <span>Refunded</span>
            <span>{formatPrice(data.refundTotal)}</span>
          </div>
        </div>
      </div>

      <div className="inv-tax-note">
        Credit note issued against invoice {data.orderRef ?? "—"} dated{" "}
        {fmtDate(data.orderDate)}. Tax shown is reversed against the output tax
        declared on that invoice.
      </div>

      {billing.footerNote && (
        <div className="inv-footer">{billing.footerNote}</div>
      )}
    </div>
  );
}
