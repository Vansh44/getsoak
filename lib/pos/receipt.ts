// ---------------------------------------------------------------------------
// The thermal-receipt view model — PURE, so the same shape feeds today's
// HTML/driver printing and a future raw ESC/POS path (docs/pos-plan.md §8)
// without the layout logic being trapped inside a React component.
//
// Everything here comes from the ORDER's own snapshot (per-line tax split, the
// state codes, the tender rows), never from live settings: a reprint six months
// later must show what was actually charged, even if the store has since moved
// state, changed GST registration, or re-priced the product.
// ---------------------------------------------------------------------------

import { gstBreakdown, type GstRateBucket } from "@/lib/billing/gst";

export interface ReceiptLine {
  name: string;
  variantName: string | null;
  hsnCode: string | null;
  quantity: number;
  unitPrice: number;
  /** Line total after any line discount (what the customer is charged). */
  total: number;
}

export interface ReceiptTender {
  method: string;
  amount: number;
  tendered: number | null;
  changeDue: number | null;
  reference: string | null;
}

export interface ReceiptModel {
  storeName: string;
  legalName: string | null;
  locationName: string | null;
  address: string | null;
  gstin: string | null;
  phone: string | null;
  receiptNo: string;
  orderRef: string;
  soldAt: string;
  cashierName: string | null;
  lines: ReceiptLine[];
  subtotal: number;
  discount: number;
  /** Tax total. Already inside the line prices when taxInclusive. */
  tax: number;
  taxInclusive: boolean;
  gstEnabled: boolean;
  /** Per-rate CGST/SGST/IGST breakdown a GST receipt must print. */
  gst: GstRateBucket[];
  /** True when this sale was taxed CGST+SGST rather than IGST. */
  intraState: boolean;
  total: number;
  tenders: ReceiptTender[];
  changeDue: number;
  customerGstin: string | null;
  footerNote: string | null;
}

export interface ReceiptSource {
  store: { name: string; legalName?: string | null; phone?: string | null };
  location: {
    name?: string | null;
    address?: unknown;
    gstin?: string | null;
  } | null;
  order: {
    receipt_no: string | null;
    order_ref: string;
    created_at: string;
    cashier_name: string | null;
    subtotal: number;
    discount: number;
    tax: number;
    tax_inclusive: boolean;
    total: number;
    customer_gstin: string | null;
    supplier_state: string | null;
    place_of_supply_state: string | null;
  };
  items: Array<{
    name: string;
    variant_name: string | null;
    hsn_code: string | null;
    quantity: number;
    price: number;
    total: number;
    tax_rate: number;
    tax_class_name: string | null;
    tax_amount: number;
    tax_cgst: number;
    tax_sgst: number;
    tax_igst: number;
  }>;
  payments: Array<{
    method: string;
    amount: number;
    tendered: number | null;
    change_due: number | null;
    reference: string | null;
  }>;
  gstEnabled: boolean;
  footerNote?: string | null;
}

/** Flatten a stored jsonb address into printable lines. */
function formatAddress(address: unknown): string | null {
  if (!address) return null;
  if (typeof address === "string") return address.trim() || null;
  if (typeof address !== "object") return null;
  const a = address as Record<string, unknown>;
  const parts = [
    a.line1,
    a.line2,
    a.addressLine1,
    a.addressLine2,
    a.city,
    a.state,
    a.postalCode,
    a.pincode,
  ]
    .filter((v): v is string => typeof v === "string" && !!v.trim())
    .map((v) => v.trim());
  return parts.length ? Array.from(new Set(parts)).join(", ") : null;
}

export function buildReceiptModel(src: ReceiptSource): ReceiptModel {
  const gst = gstBreakdown(
    src.items.map((i) => ({
      rate: i.tax_rate,
      label: i.tax_class_name ?? undefined,
      // Taxable value = the line's charge, less its tax when prices include it.
      taxableValue: src.order.tax_inclusive
        ? Math.round((i.total - i.tax_amount) * 100) / 100
        : i.total,
      cgst: i.tax_cgst,
      sgst: i.tax_sgst,
      igst: i.tax_igst,
    })),
  );

  // Derived from the SNAPSHOT, not from today's settings.
  const intraState = src.items.some((i) => i.tax_cgst > 0 || i.tax_sgst > 0);

  const changeDue = src.payments.reduce((s, p) => s + (p.change_due ?? 0), 0);

  return {
    storeName: src.store.name,
    legalName: src.store.legalName ?? null,
    locationName: src.location?.name ?? null,
    address: formatAddress(src.location?.address),
    gstin: src.location?.gstin ?? null,
    phone: src.store.phone ?? null,
    receiptNo: src.order.receipt_no || src.order.order_ref,
    orderRef: src.order.order_ref,
    soldAt: src.order.created_at,
    cashierName: src.order.cashier_name,
    lines: src.items.map((i) => ({
      name: i.name,
      variantName: i.variant_name,
      hsnCode: i.hsn_code,
      quantity: i.quantity,
      unitPrice: i.price,
      total: i.total,
    })),
    subtotal: src.order.subtotal,
    discount: src.order.discount,
    tax: src.order.tax,
    taxInclusive: src.order.tax_inclusive,
    gstEnabled: src.gstEnabled,
    gst,
    intraState,
    total: src.order.total,
    tenders: src.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      tendered: p.tendered,
      changeDue: p.change_due,
      reference: p.reference,
    })),
    changeDue: Math.round(changeDue * 100) / 100,
    customerGstin: src.order.customer_gstin,
    footerNote: src.footerNote ?? null,
  };
}

/** Human label for a tender method on the printed receipt. */
export const TENDER_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  gift_card: "Gift card",
  store_credit: "Store credit",
  razorpay: "Online",
};
