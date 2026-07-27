"use server";

// ---------------------------------------------------------------------------
// A shopper's own orders — the storefront counterpart to the dashboard's
// order-actions.ts.
//
// SCOPE IS DOUBLE-LOCKED. Every read runs under `withUser`, so the orders RLS
// policy (`customer_id = auth.uid()`) is the floor, AND each query filters by
// the HOST store. Both matter: RLS alone would let a shopper see an order they
// placed on a DIFFERENT store while browsing this one, which would leak one
// merchant's order data onto another merchant's storefront.
//
// The order id in the URL is a UUID and access is checked server-side, so a
// guessed id returns nothing rather than someone else's order (convention #14:
// the human-readable order_ref is display only, never a lookup key).
// ---------------------------------------------------------------------------

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { withUser } from "@/lib/db/client";
import { orderItems, orders } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";

export interface MyOrderRow {
  id: string;
  order_ref: string;
  created_at: string;
  status: string;
  payment_status: string;
  payment_method: string;
  total: number;
  currency: string;
  item_count: number;
  /** First line item's name, for the list's summary line. */
  first_item: string | null;
}

export interface MyOrderItem {
  id: string;
  name: string;
  variant_name: string | null;
  quantity: number;
  price: number;
  total: number;
}

export interface MyOrderDetail extends MyOrderRow {
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  applied_coupon_code: string | null;
  shipping_address: Record<string, unknown>;
  notes: string | null;
  items: MyOrderItem[];
}

/** The signed-in shopper's orders on THIS store, newest first. */
export async function getMyOrders(): Promise<{
  orders: MyOrderRow[];
  error?: string;
}> {
  const user = await getServerUser();
  if (!user) return { orders: [] };
  const storeId = await requireStorefrontStoreId();

  try {
    return await withUser(
      { uid: user.id, email: user.email ?? null },
      async (db) => {
        const rows = await db
          .select({
            id: orders.id,
            order_ref: orders.orderRef,
            created_at: orders.createdAt,
            status: orders.status,
            payment_status: orders.paymentStatus,
            payment_method: orders.paymentMethod,
            total: orders.total,
            currency: orders.currency,
          })
          .from(orders)
          .where(
            and(eq(orders.customerId, user.id), eq(orders.storeId, storeId)),
          )
          .orderBy(desc(orders.createdAt))
          .limit(100);

        if (rows.length === 0) return { orders: [] };

        // ONE query for every order's items, bounded to the ids we just proved
        // this shopper owns. The list needs a quantity total and the first item's
        // name; fetching per order would be N+1, and fetching unbounded would
        // pull every item the RLS policy allows.
        const summaries = await db
          .select({
            orderId: orderItems.orderId,
            name: orderItems.name,
            quantity: orderItems.quantity,
          })
          .from(orderItems)
          .where(
            inArray(
              orderItems.orderId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(orderItems.createdAt));

        const byOrder = new Map<
          string,
          { count: number; first: string | null }
        >();
        for (const item of summaries) {
          const entry = byOrder.get(item.orderId) ?? { count: 0, first: null };
          entry.count += item.quantity;
          if (!entry.first) entry.first = item.name;
          byOrder.set(item.orderId, entry);
        }

        return {
          orders: rows.map((row) => ({
            ...row,
            item_count: byOrder.get(row.id)?.count ?? 0,
            first_item: byOrder.get(row.id)?.first ?? null,
          })),
        };
      },
    );
  } catch (error) {
    logError("customer orders: list failed", error, { userId: user.id });
    return { orders: [], error: "Couldn't load your orders." };
  }
}

/** One of the shopper's own orders, with its line items. */
export async function getMyOrder(
  orderId: string,
): Promise<{ order?: MyOrderDetail; error?: string }> {
  const user = await getServerUser();
  if (!user) return { error: "Not signed in." };
  if (!orderId || typeof orderId !== "string") return { error: "Not found." };
  const storeId = await requireStorefrontStoreId();

  try {
    return await withUser(
      { uid: user.id, email: user.email ?? null },
      async (db) => {
        const rows = await db
          .select({
            id: orders.id,
            order_ref: orders.orderRef,
            created_at: orders.createdAt,
            status: orders.status,
            payment_status: orders.paymentStatus,
            payment_method: orders.paymentMethod,
            total: orders.total,
            currency: orders.currency,
            subtotal: orders.subtotal,
            tax: orders.tax,
            shipping: orders.shipping,
            discount: orders.discount,
            applied_coupon_code: orders.appliedCouponCode,
            shipping_address: orders.shippingAddress,
            notes: orders.notes,
          })
          .from(orders)
          .where(
            and(
              eq(orders.id, orderId),
              eq(orders.customerId, user.id),
              eq(orders.storeId, storeId),
            ),
          )
          .limit(1);

        const order = rows[0];
        if (!order) return { error: "Not found." };

        const items = await db
          .select({
            id: orderItems.id,
            name: orderItems.name,
            variant_name: orderItems.variantName,
            quantity: orderItems.quantity,
            price: orderItems.price,
            total: orderItems.total,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId))
          .orderBy(asc(orderItems.createdAt));

        return {
          order: {
            ...order,
            shipping_address: (order.shipping_address ?? {}) as Record<
              string,
              unknown
            >,
            item_count: items.reduce((n, i) => n + i.quantity, 0),
            first_item: items[0]?.name ?? null,
            items,
          },
        };
      },
    );
  } catch (error) {
    logError("customer orders: detail failed", error, { orderId });
    return { error: "Couldn't load that order." };
  }
}
