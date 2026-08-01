// Shared status vocabulary for the shopper-facing order pages.
//
// The dashboard's ORDER_STATUSES is the authority on what a status can BE
// (app/actions/order-actions.ts); this is how a shopper reads it. Kept apart on
// purpose: "pending" means "awaiting your action" to a merchant and "we've got
// it" to a customer, and those two audiences should never share one string.

import styles from "./orders.module.css";

export const ORDER_FLOW = [
  "pending",
  "processing",
  "shipped",
  "delivered",
] as const;

export const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  pending: "Order placed",
  processing: "Being prepared",
  shipped: "On the way",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const PILL_CLASS: Record<string, string> = {
  pending: styles.pillPending,
  processing: styles.pillProcessing,
  shipped: styles.pillShipped,
  delivered: styles.pillDelivered,
  cancelled: styles.pillCancelled,
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`${styles.pill} ${PILL_CLASS[status] ?? styles.pillPending}`}
    >
      {CUSTOMER_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export const PAYMENT_LABEL: Record<string, string> = {
  cash_on_delivery: "Cash on delivery",
  razorpay: "Paid online",
};

/** ₹1,240.00 */
export function money(value: number, currency = "INR"): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value}`;
  }
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
