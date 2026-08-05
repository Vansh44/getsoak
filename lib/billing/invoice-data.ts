import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { withService, withUser } from "@/lib/db/client";
import {
  orderItems,
  orders,
  storeBillingSettings,
  storeLocations,
} from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import { getStoreBillingSettings } from "@/lib/storefront/queries";
import {
  rowToBillingSettings,
  type BillingSettings,
} from "@/lib/billing/types";
import type {
  InvoiceOrderData,
  InvoiceItemData,
} from "@/components/invoice/invoice-document";

// Aliased column maps kept explicit (never select all) so a schema addition
// can't accidentally leak a new column into a customer-facing invoice.
const ORDER_COLS = {
  id: orders.id,
  store_id: orders.storeId,
  order_ref: orders.orderRef,
  order_no: orders.orderNo,
  created_at: orders.createdAt,
  status: orders.status,
  payment_method: orders.paymentMethod,
  payment_status: orders.paymentStatus,
  subtotal: orders.subtotal,
  tax: orders.tax,
  tax_inclusive: orders.taxInclusive,
  shipping: orders.shipping,
  discount: orders.discount,
  total: orders.total,
  currency: orders.currency,
  applied_coupon_code: orders.appliedCouponCode,
  notes: orders.notes,
  shipping_address: orders.shippingAddress,
  billing_address: orders.billingAddress,
  // ★ An invoice for a collection must not print a delivery address. Without
  // these the document had no way to tell the two apart, so it billed a
  // walk-in customer against a home address nothing was ever sent to.
  fulfilment_type: orders.fulfilmentType,
  pickup_location_name: sql<string | null>`(
    select l.name from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
  pickup_location_address: sql<Record<string, unknown> | null>`(
    select l.address from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
};
const ITEM_COLS = {
  name: orderItems.name,
  variant_name: orderItems.variantName,
  price: orderItems.price,
  quantity: orderItems.quantity,
  total: orderItems.total,
  tax_rate: orderItems.taxRate,
  tax_amount: orderItems.taxAmount,
  tax_class_name: orderItems.taxClassName,
};
const BILLING_COLS = {
  store_id: storeBillingSettings.storeId,
  tax_enabled: storeBillingSettings.taxEnabled,
  prices_include_tax: storeBillingSettings.pricesIncludeTax,
  default_tax_class_id: storeBillingSettings.defaultTaxClassId,
  business_name: storeBillingSettings.businessName,
  business_address: storeBillingSettings.businessAddress,
  tax_id: storeBillingSettings.taxId,
  contact_email: storeBillingSettings.contactEmail,
  contact_phone: storeBillingSettings.contactPhone,
  logo_url: storeBillingSettings.logoUrl,
  invoice_prefix: storeBillingSettings.invoicePrefix,
  accent_color: storeBillingSettings.accentColor,
  footer_note: storeBillingSettings.footerNote,
  terms: storeBillingSettings.terms,
  template: storeBillingSettings.template,
};

export interface InvoiceData {
  /** The store the order belongs to — callers verify it matches their host. */
  storeId: string;
  order: InvoiceOrderData;
  items: InvoiceItemData[];
  billing: BillingSettings;
}

/**
 * Dashboard invoice — an admin views any order in THEIR store. Service scope,
 * scoped by the acting store id (so one store can't print another's invoice).
 * Caller must already be gated on the `orders`/`billing` section.
 */
export async function loadInvoiceByStore(
  orderId: string,
): Promise<InvoiceData | null> {
  if (!orderId) return null;
  const storeId = await getActingStoreId();

  try {
    return await withService(async (db) => {
      const orderRows = await db
        .select(ORDER_COLS)
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
        .limit(1);
      const order = orderRows[0];
      if (!order) return null;

      const items = await db
        .select(ITEM_COLS)
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));
      const billingRows = await db
        .select(BILLING_COLS)
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, storeId))
        .limit(1);

      return {
        storeId,
        order: order as unknown as InvoiceOrderData,
        items: items as unknown as InvoiceItemData[],
        billing: rowToBillingSettings(
          (billingRows[0] as Record<string, unknown> | undefined) ?? null,
        ),
      };
    });
  } catch (err) {
    console.error(
      "loadInvoiceByStore:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Customer invoice — a signed-in shopper views THEIR OWN order. Read under the
 * customer's identity, so RLS (orders SELECT is customer_id = auth.uid())
 * enforces ownership; a stranger's order id simply resolves to null. Billing
 * settings are public storefront data (business identity printed on the invoice).
 */
export async function loadInvoiceForCustomer(
  orderId: string,
): Promise<InvoiceData | null> {
  if (!orderId) return null;
  const user = await getServerUser();
  if (!user) return null;

  let order: Record<string, unknown> | undefined;
  let items: unknown[] = [];
  try {
    ({ order, items } = await withUser(
      { uid: user.id, email: user.email },
      async (db) => {
        // No explicit customer filter — RLS confines this to the caller's orders.
        const orderRows = await db
          .select(ORDER_COLS)
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1);
        if (!orderRows[0]) return { order: undefined, items: [] };
        const itemRows = await db
          .select(ITEM_COLS)
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId));
        return {
          order: orderRows[0] as Record<string, unknown>,
          items: itemRows as unknown[],
        };
      },
    ));
  } catch (err) {
    console.error(
      "loadInvoiceForCustomer:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  if (!order) return null;

  const orderStoreId = order.store_id as string;
  const billing = await getStoreBillingSettings(orderStoreId);

  return {
    storeId: orderStoreId,
    order: order as unknown as InvoiceOrderData,
    items: items as unknown as InvoiceItemData[],
    billing,
  };
}
