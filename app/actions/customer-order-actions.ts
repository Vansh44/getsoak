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

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService, withUser } from "@/lib/db/client";
import { orderItems, orders, products, storeLocations } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";
import { getStoreSettings } from "@/lib/settings/resolve";
import { rateLimit } from "@/lib/rate-limit";
import { emitEvent } from "@/lib/notifications/record";
import {
  SELF_CANCELLABLE_STATUSES,
  canCustomerCancel,
  rulesFromSettings,
} from "@/lib/orders/cancellation";
import { approveCancellation } from "@/lib/orders/approve-cancellation";

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
  /** Up to three product images, so the list is scannable by sight rather than
   *  by reading order references. Nulls kept out — the UI shows a placeholder. */
  thumbnails: string[];
  /** 'delivery' for everything that isn't a collection. The list needs it too:
   *  "Order placed" looks the same whether a van is coming or the shopper has
   *  to drive over, and the badge is the only thing that says which. */
  fulfilment_type: string;
  pickup_status: string | null;
}

export interface MyOrderItem {
  id: string;
  name: string;
  variant_name: string | null;
  quantity: number;
  price: number;
  total: number;
  /** Product photo, or null once the product is gone — the line keeps its
   *  snapshotted name either way. */
  image: string | null;
}

export interface MyOrderDetail extends Omit<MyOrderRow, "thumbnails"> {
  subtotal: number;
  tax: number;
  shipping: number;
  discount: number;
  applied_coupon_code: string | null;
  shipping_address: Record<string, unknown>;
  notes: string | null;
  /** When the shop said it would be ready — the date quoted at checkout. The
   *  page needs it as well as `pickup_status`: the promise and "a human has
   *  pressed ready" are two different facts, and reading only the second told
   *  a same-day store's customers "we'll let you know when it's ready". */
  pickup_ready_at: string | null;
  pickup_expires_at: string | null;
  /** The code shown at the counter. A LOOKUP key, not a bearer token — the
   *  page is already owner-gated (lib/fulfilment/collection-code.ts). */
  pickup_code: string | null;
  pickup_location_name: string | null;
  pickup_location_address: Record<string, unknown> | null;
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
            fulfilment_type: orders.fulfilmentType,
            pickup_status: orders.pickupStatus,
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
            // Left-joined: a product deleted since the order was placed still
            // has its snapshotted name on the line, and simply shows no photo.
            image: products.imageUrl,
          })
          .from(orderItems)
          .leftJoin(products, eq(products.id, orderItems.productId))
          .where(
            inArray(
              orderItems.orderId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(orderItems.createdAt));

        const byOrder = new Map<
          string,
          { count: number; first: string | null; thumbnails: string[] }
        >();
        for (const item of summaries) {
          const entry = byOrder.get(item.orderId) ?? {
            count: 0,
            first: null,
            thumbnails: [],
          };
          entry.count += item.quantity;
          if (!entry.first) entry.first = item.name;
          // Three is what fits before the stack stops reading as a stack.
          if (item.image && entry.thumbnails.length < 3) {
            entry.thumbnails.push(item.image);
          }
          byOrder.set(item.orderId, entry);
        }

        return {
          orders: rows.map((row) => ({
            ...row,
            item_count: byOrder.get(row.id)?.count ?? 0,
            first_item: byOrder.get(row.id)?.first ?? null,
            thumbnails: byOrder.get(row.id)?.thumbnails ?? [],
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
            fulfilment_type: orders.fulfilmentType,
            pickup_status: orders.pickupStatus,
            pickup_ready_at: orders.pickupReadyAt,
            pickup_expires_at: orders.pickupExpiresAt,
            pickup_code: orders.pickupCode,
            pickup_location_name: sql<string | null>`(
              select l.name from ${storeLocations} l
               where l.id = ${orders.pickupLocationId}
            )`,
            pickup_location_address: sql<Record<string, unknown> | null>`(
              select l.address from ${storeLocations} l
               where l.id = ${orders.pickupLocationId}
            )`,
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
            // Left join: a product deleted since the order still shows its
            // snapshotted name and price, just without a photo.
            image: products.imageUrl,
          })
          .from(orderItems)
          .leftJoin(products, eq(products.id, orderItems.productId))
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

// ---------------------------------------------------------------------------
// Customer-initiated cancellation (roadmap Step 2)
// ---------------------------------------------------------------------------

export interface CancelMyOrderResult {
  /** Cancelled outright — stock is back, the store has been told. */
  cancelled?: boolean;
  /** Too late to cancel automatically; the store has been asked to. */
  requested?: boolean;
  /** Money the store now owes, when there is any. Display only. */
  refundDue?: number;
  error?: string;
}

/** Statuses a shopper may cancel out of without anyone looking. Anything
 *  further along has left the building, physically or nearly. */

/**
 * Cancel my own order — or, when it's too late for that, ask the store to.
 *
 * ★ ONE BUTTON, TWO OUTCOMES, and the difference is decided server-side. A
 * shopper should not have to work out whether their order is still stoppable;
 * they press Cancel and either it stops or the store hears about it. Hiding
 * the button once an order ships would be worse — the customer still wants out
 * and would have nowhere to say so.
 *
 * ★ AND IT NEVER MOVES MONEY. A cancellation returns stock and records what is
 * owed; the refund stays a human decision in the dashboard (§2.2). The
 * alternative is a shopper being able to trigger a payout from a public
 * storefront action, which is not a thing to build.
 */
export async function cancelMyOrder(
  orderId: string,
  reason?: string,
): Promise<CancelMyOrderResult> {
  const user = await getServerUser();
  if (!user) return { error: "Please sign in." };
  if (typeof orderId !== "string" || !orderId.trim()) {
    return { error: "Invalid order." };
  }
  const storeId = await requireStorefrontStoreId();

  const { allowed } = await rateLimit(`cancel:${user.id}`, {
    max: 10,
    windowSeconds: 3600,
  });
  if (!allowed) {
    return { error: "Too many attempts. Please try again shortly." };
  }

  const rules = rulesFromSettings(await getStoreSettings());
  const identity = { uid: user.id, email: user.email ?? null };
  const note = reason?.trim().slice(0, 200) || null;

  let order:
    | {
        id: string;
        order_ref: string | null;
        status: string;
        payment_status: string | null;
        total: number | null;
        created_at: string | null;
        collected_at: string | null;
        cancellation_status: string | null;
      }
    | undefined;
  try {
    const rows = await withUser(identity, (db) =>
      db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          status: orders.status,
          payment_status: orders.paymentStatus,
          total: orders.total,
          created_at: orders.createdAt,
          collected_at: orders.collectedAt,
          cancellation_status: orders.cancellationStatus,
        })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.customerId, user.id),
            eq(orders.storeId, storeId),
          ),
        )
        .limit(1),
    );
    order = rows[0];
  } catch (error) {
    logError("customer orders: cancel lookup failed", error, { orderId });
    return { error: "Couldn't load that order." };
  }
  if (!order) return { error: "Not found." };

  // ★ THE SAME RULE THE BUTTON ASKED, RE-ASKED HERE. The order page hides the
  // control when this refuses, but a hidden control is not a permission
  // (invariant 5) — the window, the fulfilment state and the one-request rule
  // are all enforced on this side too.
  const eligible = canCustomerCancel(
    {
      status: order.status,
      createdAt: order.created_at,
      collectedAt: order.collected_at,
      cancellationStatus: order.cancellation_status,
    },
    rules,
  );
  if (!eligible.ok) return { error: eligible.reason };

  // ── Raise the request ────────────────────────────────────────────────────
  // ★ ASKING IS NOT CANCELLING. The default is that a human decides: money and
  // stock move on APPROVAL, not on a customer pressing a button. The claim is
  // conditional on no request already existing, which is what makes a
  // double-submit produce one request rather than two.
  let claimedRequest: { id: string }[];
  try {
    claimedRequest = await withService((db) =>
      db
        .update(orders)
        .set({
          cancellationStatus: "requested",
          cancellationRequestedAt: sql`now()`,
          cancellationReason: note,
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.customerId, user.id),
            eq(orders.storeId, storeId),
            isNull(orders.cancellationStatus),
            inArray(orders.status, [...SELF_CANCELLABLE_STATUSES]),
          ),
        )
        .returning({ id: orders.id }),
    );
  } catch (error) {
    logError("customer orders: cancel request failed", error, { orderId });
    return { error: "Couldn't send that request. Please contact the store." };
  }
  if (!claimedRequest.length) {
    // Someone moved the order, or a second tab got here first.
    return { error: "This order has moved on and can't be cancelled now." };
  }

  emitEvent({
    type: "order.cancellation_requested",
    storeId,
    actor: { type: "customer", id: user.id, label: user.email ?? null },
    subject: { type: "order", id: order.id, label: order.order_ref },
    customerId: user.id,
    payload: {
      orderRef: order.order_ref ?? "",
      status: order.status,
      total: Number(order.total ?? 0),
      currency: "INR",
      ...(note ? { reason: note } : {}),
    },
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);

  // ── Auto-approve, if the merchant asked for it ───────────────────────────
  // Off by default. The request row is written FIRST and approved second, so an
  // auto-approval that fails half way leaves a request a merchant can still see
  // and act on — rather than a silent nothing.
  if (rules.approval === "auto") {
    const approved = await approveCancellation({
      storeId,
      orderId,
      actorId: user.id,
      actorLabel: user.email ?? null,
      customerId: user.id,
      // The merchant configured automation, not a destination per order; the
      // obligation is recorded and their refund panel shows what is owed.
      refundDestination: "later",
      reasonCode: "customer_changed_mind",
      restock: true,
      notify: true,
    });
    if (approved.error) {
      // The REQUEST stands — it is in the merchant's queue either way, which is
      // the honest outcome. Never report a cancellation that did not happen.
      return { requested: true };
    }
    return { cancelled: true, refundDue: approved.refundDue };
  }

  return { requested: true };
}
