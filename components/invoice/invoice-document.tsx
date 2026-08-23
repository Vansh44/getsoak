import { formatPrice } from "@/lib/pricing";
import type { BillingSettings } from "@/lib/billing/types";
import { locationAddressLines } from "@/lib/locations/address";
import "./invoice.css";

export interface InvoiceOrderData {
  order_ref: string | null;
  order_no: number | null;
  created_at: string;
  status: string;
  payment_method: string;
  payment_status: string;
  subtotal: number;
  tax: number;
  tax_inclusive: boolean;
  shipping: number;
  discount: number;
  total: number;
  currency: string;
  applied_coupon_code: string | null;
  notes: string | null;
  shipping_address: Record<string, unknown> | null;
  billing_address: Record<string, unknown> | null;
  sales_channel?: string | null;
  sale_location_name?: string | null;
  sale_location_address?: Record<string, unknown> | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  customer_phone?: string | null;
  customer_email?: string | null;
  /** 'delivery' for everything that isn't a collection. Optional so an older
   *  caller still type-checks; absent reads as delivery, which is what every
   *  order was before pickup existed. */
  fulfilment_type?: string | null;
  pickup_location_name?: string | null;
  /** The SHOP's address — `line1`/`city`/… , not the customer address shape
   *  (see lib/locations/address.ts). */
  pickup_location_address?: Record<string, unknown> | null;
}

export interface InvoiceItemData {
  name: string;
  variant_name: string | null;
  price: number;
  quantity: number;
  total: number;
  tax_rate: number;
  tax_amount: number;
  tax_class_name: string | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function formatAddress(a: Record<string, unknown> | null): {
  name: string;
  lines: string[];
  email: string;
  phone: string;
} {
  if (!a) return { name: "", lines: [], email: "", phone: "" };
  const name = `${str(a.firstName)} ${str(a.lastName)}`.trim();
  const lines = [
    str(a.addressLine1),
    str(a.addressLine2),
    [str(a.city), str(a.state), str(a.postalCode)].filter(Boolean).join(", "),
    str(a.country),
  ].filter(Boolean);
  return { name, lines, email: str(a.email), phone: str(a.phone) };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function InvoiceDocument({
  order,
  items,
  billing,
}: {
  order: InvoiceOrderData;
  items: InvoiceItemData[];
  billing: BillingSettings;
}) {
  const t = billing.template;
  // COD orders store billing_address as null — billing falls back to shipping
  // (they're the same party), matching how the order was actually placed.
  const shipTo = formatAddress(order.shipping_address);
  const billTo = order.billing_address
    ? formatAddress(order.billing_address)
    : shipTo;
  const isPosSale = order.sales_channel === "pos";
  const posCustomer = {
    name: [order.customer_first_name, order.customer_last_name]
      .filter(Boolean)
      .join(" "),
    lines: [] as string[],
    phone: order.customer_phone ?? "",
    email: order.customer_email ?? "",
  };
  const customerParty = isPosSale ? posCustomer : billTo;

  // ★ NOTHING IS SHIPPED TO A COLLECTION ORDER. The second party block named
  // the customer's home address under "Ship To" on an order they walked in and
  // picked up — an address the goods never went to, on the document that is
  // supposed to be the record of the sale. For a pickup it names the SHOP
  // instead, and the customer party is always rendered so the invoice still
  // says who bought it even when the Bill To flag is off.
  const isPickup = order.fulfilment_type === "pickup";
  const showCustomerParty = t.showBillingAddress || isPickup || isPosSale;
  const pickupLines = locationAddressLines(order.pickup_location_address);
  const saleLocationLines = locationAddressLines(order.sale_location_address);

  // Whether this ORDER carried tax — from the order's own snapshot, never the
  // store's live settings, so a later settings change can't rewrite history.
  const hasTax = order.tax > 0 || items.some((i) => Number(i.tax_rate) > 0);

  // Group per-line tax into rate buckets for the summary.
  const buckets = new Map<number, { label: string; tax: number }>();
  for (const it of items) {
    if (!it.tax_amount || it.tax_rate <= 0) continue;
    const b = buckets.get(it.tax_rate);
    if (b) b.tax += it.tax_amount;
    else
      buckets.set(it.tax_rate, {
        label: it.tax_class_name || `Tax ${it.tax_rate}%`,
        tax: it.tax_amount,
      });
  }
  const taxRows = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, v]) => ({ rate, label: v.label, tax: v.tax }));

  const invoiceNo = order.order_no
    ? `${billing.invoicePrefix}${order.order_no}`
    : (order.order_ref ?? "");

  const accentStyle = {
    ["--inv-accent" as string]: billing.accentColor,
  } as React.CSSProperties;

  return (
    <div className="invoice-sheet" style={accentStyle}>
      {/* Header */}
      <div className="inv-head">
        <div>
          {t.showLogo && billing.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="inv-logo"
              src={billing.logoUrl}
              alt={billing.businessName || "Logo"}
            />
          )}
          <div className="inv-biz-name">
            {billing.businessName || "Your Business"}
          </div>
          {t.showBusinessAddress && billing.businessAddress && (
            <div className="inv-biz-meta">{billing.businessAddress}</div>
          )}
          <div className="inv-biz-meta">
            {[billing.contactEmail, billing.contactPhone]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {t.showTaxId && billing.taxId && (
            <div className="inv-biz-meta">GSTIN: {billing.taxId}</div>
          )}
        </div>

        <div className="inv-title">
          <h1>{t.title || "Invoice"}</h1>
          {invoiceNo && (
            <div className="inv-meta-row">
              <b>No:</b> {invoiceNo}
            </div>
          )}
          {order.order_ref && (
            <div className="inv-meta-row">
              <b>Order:</b> {order.order_ref}
            </div>
          )}
          <div className="inv-meta-row">
            <b>Date:</b> {formatDate(order.created_at)}
          </div>
        </div>
      </div>

      {/* Parties — the customer (optional by template flag, but always shown
          for a collection) + where the goods went: Ship To, or Collect From. */}
      <div className="inv-parties">
        {showCustomerParty && (
          <div>
            <div className="inv-party-label">Bill To</div>
            <div className="inv-party-body">
              <div className="name">
                {customerParty.name ||
                  (isPosSale ? "Walk-in customer" : "Customer")}
              </div>
              {customerParty.lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
              {customerParty.phone && <div>{customerParty.phone}</div>}
              {customerParty.email && <div>{customerParty.email}</div>}
            </div>
          </div>
        )}
        {isPosSale ? (
          <div>
            <div className="inv-party-label">Sold At</div>
            <div className="inv-party-body">
              <div className="name">
                {order.sale_location_name || "Store location"}
              </div>
              {saleLocationLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        ) : isPickup ? (
          <div>
            <div className="inv-party-label">Collect From</div>
            <div className="inv-party-body">
              <div className="name">
                {order.pickup_location_name || "Our shop"}
              </div>
              {pickupLines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <div className="inv-party-label">Ship To</div>
            <div className="inv-party-body">
              <div className="name">{shipTo.name || "Customer"}</div>
              {shipTo.lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
              {!t.showBillingAddress && shipTo.phone && (
                <div>{shipTo.phone}</div>
              )}
              {!t.showBillingAddress && shipTo.email && (
                <div>{shipTo.email}</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Items */}
      <table className="inv-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            {hasTax && <th className="num">Tax</th>}
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>
                <div className="inv-item-name">{it.name}</div>
                {it.variant_name && (
                  <div className="inv-item-variant">{it.variant_name}</div>
                )}
              </td>
              <td className="num">{it.quantity}</td>
              <td className="num">{formatPrice(it.price)}</td>
              {hasTax && (
                <td className="num">
                  {it.tax_rate > 0 ? `${it.tax_rate}%` : "—"}
                </td>
              )}
              <td className="num">{formatPrice(it.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="inv-totals">
        <div className="inv-totals-inner">
          <div className="inv-total-row">
            <span>Subtotal</span>
            <span>{formatPrice(order.subtotal)}</span>
          </div>
          {order.discount > 0 && (
            <div className="inv-total-row discount">
              <span>
                Discount
                {order.applied_coupon_code
                  ? ` (${order.applied_coupon_code})`
                  : ""}
              </span>
              <span>−{formatPrice(order.discount)}</span>
            </div>
          )}
          {!order.tax_inclusive &&
            taxRows.map((r) => (
              <div className="inv-total-row" key={r.rate}>
                <span>{r.label}</span>
                <span>{formatPrice(r.tax)}</span>
              </div>
            ))}
          <div className="inv-total-row">
            <span>Shipping</span>
            <span>
              {order.shipping > 0 ? formatPrice(order.shipping) : "Free"}
            </span>
          </div>
          <div className="inv-total-grand">
            <span>Total</span>
            <span>{formatPrice(order.total)}</span>
          </div>
          {order.tax_inclusive && order.tax > 0 && (
            <div className="inv-tax-note">
              Inclusive of tax {formatPrice(order.tax)}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="inv-footer">
        {t.showPaymentMethod && (
          <div>
            <h4>Payment</h4>
            <p>
              <span className="inv-pay-badge">
                {order.payment_method === "cash_on_delivery"
                  ? "Cash on Delivery"
                  : order.payment_method === "pay_at_store"
                    ? "Pay at Store"
                    : order.payment_method}
              </span>{" "}
              ·{" "}
              {order.payment_status
                .replace(/_/g, " ")
                .replace(/^./, (c) => c.toUpperCase())}
            </p>
          </div>
        )}
        {t.showNotes && order.notes && (
          <div>
            <h4>Notes</h4>
            <p>{order.notes}</p>
          </div>
        )}
        {billing.terms && (
          <div>
            <h4>Terms &amp; Conditions</h4>
            <p>{billing.terms}</p>
          </div>
        )}
        {billing.footerNote && (
          <div>
            <p>{billing.footerNote}</p>
          </div>
        )}
      </div>
    </div>
  );
}
