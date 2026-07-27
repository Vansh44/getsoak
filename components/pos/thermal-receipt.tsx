import { TENDER_LABEL, type ReceiptModel } from "@/lib/pos/receipt";
import "./thermal-receipt.css";

// Presentational only — every value comes from the order's snapshot via
// buildReceiptModel, so a reprint always matches what was charged.

function money(n: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-IN");
}

export function ThermalReceipt({ receipt }: { receipt: ReceiptModel }) {
  const r = receipt;
  const showGst = r.gstEnabled && r.gst.length > 0;

  return (
    <div className="tr-sheet">
      <div className="tr-center">
        <div className="tr-lg">{r.legalName || r.storeName}</div>
        {r.locationName && <div>{r.locationName}</div>}
        {r.address && <div className="tr-muted">{r.address}</div>}
        {r.phone && <div className="tr-muted">{r.phone}</div>}
        {r.gstin && <div className="tr-muted">GSTIN: {r.gstin}</div>}
      </div>

      <hr className="tr-rule" />

      <div className="tr-row">
        <span>Receipt</span>
        <span className="tr-bold">{r.receiptNo}</span>
      </div>
      <div className="tr-row">
        <span>Date</span>
        <span>{when(r.soldAt)}</span>
      </div>
      {r.cashierName && (
        <div className="tr-row">
          <span>Served by</span>
          <span>{r.cashierName}</span>
        </div>
      )}
      {r.customerGstin && (
        <div className="tr-row">
          <span>Customer GSTIN</span>
          <span>{r.customerGstin}</span>
        </div>
      )}

      <hr className="tr-rule" />

      {r.lines.map((l, i) => (
        <div className="tr-item" key={i}>
          <div className="tr-item-name">
            {l.name}
            {l.variantName ? ` · ${l.variantName}` : ""}
          </div>
          <div className="tr-row">
            <span className="tr-muted">
              {l.quantity} × {money(l.unitPrice)}
              {l.hsnCode ? `  HSN ${l.hsnCode}` : ""}
            </span>
            <span>{money(l.quantity * l.unitPrice)}</span>
          </div>
          {/* Without this the line reads "2 × 100 ... 170" and the customer
              is left to work out where the ₹30 went. */}
          {l.lineDiscount > 0 && (
            <div className="tr-row">
              <span className="tr-muted">Less</span>
              <span>
                −{money(l.lineDiscount)} = {money(l.total)}
              </span>
            </div>
          )}
        </div>
      ))}

      <hr className="tr-rule" />

      <div className="tr-row">
        <span>Subtotal</span>
        <span>{money(r.subtotal)}</span>
      </div>
      {r.discount > 0 && (
        <div className="tr-row">
          <span>Discount</span>
          <span>−{money(r.discount)}</span>
        </div>
      )}
      {r.tax > 0 && (
        <div className="tr-row">
          <span>{r.taxInclusive ? "Tax (included)" : "Tax"}</span>
          <span>{money(r.tax)}</span>
        </div>
      )}

      <div className="tr-row tr-total" style={{ marginTop: 4 }}>
        <span>TOTAL</span>
        <span>₹{money(r.total)}</span>
      </div>

      <hr className="tr-rule" />

      {r.tenders.map((t, i) => (
        <div className="tr-row" key={i}>
          <span>{TENDER_LABEL[t.method] ?? t.method}</span>
          <span>{money(t.amount)}</span>
        </div>
      ))}
      {r.changeDue > 0 && (
        <div className="tr-row tr-bold">
          <span>Change</span>
          <span>{money(r.changeDue)}</span>
        </div>
      )}

      {/* GST summary — what a compliant receipt must itemise per rate. */}
      {showGst && (
        <>
          <hr className="tr-rule" />
          <div className="tr-bold">Tax summary</div>
          <table className="tr-gst-table">
            <thead>
              <tr>
                <th>Rate</th>
                <th>Taxable</th>
                {r.intraState ? (
                  <>
                    <th>CGST</th>
                    <th>SGST</th>
                  </>
                ) : (
                  <th>IGST</th>
                )}
              </tr>
            </thead>
            <tbody>
              {r.gst.map((b) => (
                <tr key={b.rate}>
                  <td>{b.rate}%</td>
                  <td>{money(b.taxableValue)}</td>
                  {r.intraState ? (
                    <>
                      <td>{money(b.cgst)}</td>
                      <td>{money(b.sgst)}</td>
                    </>
                  ) : (
                    <td>{money(b.igst)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <hr className="tr-rule" />
      <div className="tr-center tr-footer">
        {r.footerNote ? <div>{r.footerNote}</div> : null}
        <div>Thank you!</div>
        <div className="tr-muted">{r.orderRef}</div>
      </div>
    </div>
  );
}
