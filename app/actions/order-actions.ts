"use server";

import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService, withUser } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  orderItems,
  orders,
  products,
  productVariants,
  storeLocations,
} from "@/drizzle/schema";
import { releaseCancelledOrder } from "@/lib/orders/cancel";
import {
  getActingStoreId,
  getManagerIdentity,
  getManagerUserId,
} from "@/app/dashboard/lib/access";
import { getViewerLocations } from "@/lib/locations/scope";
import {
  DASHBOARD_PAGE_SIZE,
  sanitizeSearch,
} from "@/app/dashboard/lib/list-params";
import { emitEvent } from "@/lib/notifications/record";

// Allowlists — order/payment state is a closed set, so never trust an arbitrary
// string from the client into the DB (keeps the status column clean + prevents
// a mistyped/hostile value from poisoning downstream logic and filters).
const ORDER_STATUSES = [
  "pending",
  "processing",
  "shipped",
  "delivered",
  // In-person POS sales are fulfilled the moment they're rung (CODEBASE §22).
  "completed",
  "cancelled",
] as const;
// ★ Two lists, because "a value the column can hold" and "a value a human may
// choose" are different questions.
//
// `refunded` / `partially_refunded` are written by the refund machinery
// (refund-actions.ts, and the till's processReturn before it), derived from
// the refunds that actually settled. A human must NOT be able to set them
// directly: doing so asserts money went back when no order_refunds row says
// so, and that row is the one a merchant gets asked about months later.
//
// Filtering, though, has to know about them — before this split, `refunded`
// was a value the DB already contained and the orders list treated as invalid,
// so a merchant could not find their own refunded orders.
const PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
] as const;
/** What `updateOrderStatus` will accept. Strictly narrower — see above. */
const SETTABLE_PAYMENT_STATUSES = ["pending", "paid", "failed"] as const;
// "split" = a POS sale settled across several tenders; the itemised breakdown
// lives in order_payments.
const PAYMENT_METHODS = [
  "cash_on_delivery",
  "razorpay",
  "cash",
  "card",
  "upi",
  "split",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// Per-status row counts for the list's filter tabs (store-wide, ignoring the
// active filters — mirrors the products list). `all` is the store total.
export interface OrderStatusCounts {
  all: number;
  pending: number;
  processing: number;
  shipped: number;
  delivered: number;
  completed: number;
  cancelled: number;
}

const ZERO_COUNTS: OrderStatusCounts = {
  all: 0,
  pending: 0,
  processing: 0,
  shipped: 0,
  delivered: 0,
  completed: 0,
  cancelled: 0,
};

// Filters accepted by the orders list. All optional; anything not in the
// allowlists is ignored (treated as "all") so a bad query param can never
// reach the DB or break the query.
export interface GetOrdersParams {
  page?: number;
  pageSize?: number;
  /** Order status tab (one of ORDER_STATUSES); "" / unknown = all. */
  status?: string;
  /** Payment status facet (one of PAYMENT_STATUSES); "" / unknown = all. */
  paymentStatus?: string;
  /** Payment method facet (one of PAYMENT_METHODS); "" / unknown = all. */
  paymentMethod?: string;
  /** Free-text search over order ref + customer name/city. */
  q?: string;
  /** Relative date window: "today" | "7d" | "30d" | "90d" | "" (all time). */
  dateRange?: string;
}

// Map a date-window preset to its lower bound (ISO), or null for "all time".
function dateFloor(range: string): string | null {
  const DAY = 86_400_000;
  const now = Date.now();
  switch (range) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "7d":
      return new Date(now - 7 * DAY).toISOString();
    case "30d":
      return new Date(now - 30 * DAY).toISOString();
    case "90d":
      return new Date(now - 90 * DAY).toISOString();
    default:
      return null;
  }
}

// Columns the dashboard orders LIST renders. Deliberately not every column and
// not the order_items join — the table only needs these, and pulling every
// line item for every order made the query grow without bound. Aliased to the
// snake_case shape the view expects.
const ORDER_LIST_COLUMNS = {
  id: orders.id,
  order_no: orders.orderNo,
  order_ref: orders.orderRef,
  created_at: orders.createdAt,
  total: orders.total,
  currency: orders.currency,
  payment_method: orders.paymentMethod,
  payment_status: orders.paymentStatus,
  status: orders.status,
  shipping_address: orders.shippingAddress,
  // Office staff could not tell a collection from a delivery here at all —
  // only /pos/pickups knew. Two columns, no join: the badge needs the type and
  // the stage, and the shop's name belongs in the drawer, not a list row.
  fulfilment_type: orders.fulfilmentType,
  pickup_status: orders.pickupStatus,
};

export interface OrdersResult {
  orders: Record<string, unknown>[];
  total: number;
  counts: OrderStatusCounts;
  error?: string;
}

export async function getOrders(
  params: GetOrdersParams = {},
): Promise<OrdersResult> {
  const admin = await getManagerIdentity("orders");
  if (!admin)
    return {
      error: "Not authenticated",
      orders: [],
      total: 0,
      counts: ZERO_COUNTS,
    };

  const storeId = await getActingStoreId();

  const safePage =
    Number.isFinite(params.page) && (params.page ?? 0) > 0
      ? Math.trunc(params.page as number)
      : 1;
  const rawSize = params.pageSize ?? DASHBOARD_PAGE_SIZE;
  const safeSize =
    Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(Math.trunc(rawSize), 100)
      : DASHBOARD_PAGE_SIZE;
  const from = (safePage - 1) * safeSize;

  // Validate each filter against its allowlist; anything else = "all" (undefined).
  const status = ORDER_STATUSES.includes(params.status as OrderStatus)
    ? (params.status as OrderStatus)
    : undefined;
  const paymentStatus = PAYMENT_STATUSES.includes(
    params.paymentStatus as PaymentStatus,
  )
    ? (params.paymentStatus as PaymentStatus)
    : undefined;
  const paymentMethod = PAYMENT_METHODS.includes(
    params.paymentMethod as PaymentMethod,
  )
    ? (params.paymentMethod as PaymentMethod)
    : undefined;
  const term = sanitizeSearch(params.q ?? "");

  // Base scope shared by the list, its total, AND the status-tab counts: store +
  // the date window (so a date filter narrows the tab counts too). The other
  // facets (status/payment/method/search) narrow only the LIST + its total.
  const dateFrom = dateFloor(params.dateRange ?? "");
  const baseConds = [eq(orders.storeId, storeId)];
  if (dateFrom) baseConds.push(gte(orders.createdAt, dateFrom));

  // Location scope — the second tenancy dimension (roadmap Phase B2). Derived
  // from the VIEWER, never from a parameter: a filter the client can set is
  // not a permission boundary. null = unrestricted (owner, superadmin, or an
  // admin nobody has assigned), which is every store's behaviour until
  // someone is deliberately bound to a shop.
  //
  // Orders with no location (every online order until fulfilment routing lands
  // in Phase D) stay visible to everyone — they belong to no shop, and hiding
  // them would take the entire online order book away from location-bound
  // staff.
  const locationScope = await getViewerLocations();
  if (locationScope !== null) {
    baseConds.push(
      or(
        isNull(orders.locationId),
        locationScope.length > 0
          ? inArray(orders.locationId, locationScope)
          : sql`false`,
      )!,
    );
  }

  const conds = [...baseConds];
  if (status) conds.push(eq(orders.status, status));
  if (paymentStatus) conds.push(eq(orders.paymentStatus, paymentStatus));
  if (paymentMethod) conds.push(eq(orders.paymentMethod, paymentMethod));
  if (term) {
    const pat = `%${term}%`;
    // Search the human order ref + the customer name/city stored in the
    // shipping_address jsonb (->> extracts text for ILIKE).
    conds.push(
      or(
        ilike(orders.orderRef, pat),
        sql`${orders.shippingAddress}->>'firstName' ilike ${pat}`,
        sql`${orders.shippingAddress}->>'lastName' ilike ${pat}`,
        sql`${orders.shippingAddress}->>'city' ilike ${pat}`,
      )!,
    );
  }
  const whereExpr = and(...conds);
  const countWhere = and(...baseConds);

  try {
    // User scope (RLS enforced) + the explicit store filter above. The FULL
    // identity — uid AND email — matters: the orders policy delegates to
    // is_store_admin(store_id), whose platform-operator branch matches
    // platform_admins BY EMAIL via auth.email(). Opened with a uid alone, a
    // platform operator (no admins row for this store) matches no policy and
    // gets a silently empty list — the bug where /dashboard/orders said
    // "No orders yet" while analytics showed nine orders. getManagerIdentity
    // returns exactly what withUser needs, so that omission can't recur.
    const { rows, total, statusRows } = await withUser(admin, async (db) => {
      // Sequential, NOT Promise.all: these share one pooled connection, which
      // can only run one query at a time — parallelising them just trips pg's
      // "query while another is in flight" deprecation (removed in pg@9) with
      // no speedup, since the connection serialises them anyway.
      const rows = await db
        .select(ORDER_LIST_COLUMNS)
        .from(orders)
        .where(whereExpr)
        .orderBy(desc(orders.createdAt))
        .limit(safeSize)
        .offset(from);
      const countRows = await db
        .select({ n: count() })
        .from(orders)
        .where(whereExpr);
      // Store-wide per-status counts for the filter tabs (ignores the active
      // facets, so a tab always shows its full store count).
      const statusRows = await db
        .select({ status: orders.status, n: count() })
        .from(orders)
        .where(countWhere)
        .groupBy(orders.status);
      return { rows, total: countRows[0]?.n ?? 0, statusRows };
    });

    const counts: OrderStatusCounts = { ...ZERO_COUNTS };
    for (const row of statusRows) {
      counts.all += row.n;
      if (row.status && row.status in counts) {
        (counts as unknown as Record<string, number>)[row.status] = row.n;
      }
    }

    return { orders: rows as Record<string, unknown>[], total, counts };
  } catch (err) {
    console.error("Error fetching orders:", err);
    return {
      error: dbErrorMessage(err, "Failed to load orders."),
      orders: [],
      total: 0,
      counts: ZERO_COUNTS,
    };
  }
}

export async function updateOrderStatus(
  orderId: string,
  status: string,
  paymentStatus?: string,
): Promise<{ success?: boolean; error?: string }> {
  const admin = await getManagerIdentity("orders");
  if (!admin) return { error: "Not authenticated" };

  if (typeof orderId !== "string" || !orderId.trim()) {
    return { error: "Invalid order." };
  }
  if (!ORDER_STATUSES.includes(status as OrderStatus)) {
    return { error: "Invalid order status." };
  }
  if (
    paymentStatus !== undefined &&
    !SETTABLE_PAYMENT_STATUSES.includes(
      paymentStatus as (typeof SETTABLE_PAYMENT_STATUSES)[number],
    )
  ) {
    // Includes the refund states on purpose: they are derived from
    // order_refunds, never typed in. Refund the order to reach them.
    return { error: "Invalid payment status." };
  }

  const storeId = await getActingStoreId();

  // Cancelling gives back whatever the order was holding — reserved stock at
  // the location that reserved it, or pickup holds for a collection order.
  // ONE implementation, shared with the customer-initiated path
  // (lib/orders/cancel.ts); the manager gate + store scope above is the
  // authority it relies on. Best-effort: the status change is the source of
  // truth and must never be blocked by a stock write.
  if (status === "cancelled") {
    await releaseCancelledOrder(storeId, orderId, (fn) => withUser(admin, fn));
  }

  const updateData: {
    status: string;
    paymentStatus?: string;
    deliveredAt?: SQL;
  } = { status };
  if (paymentStatus) {
    updateData.paymentStatus = paymentStatus;
  }
  // When the parcel actually landed — the return window counts from here, not
  // from created_at (refunds_01_gateway.sql). COALESCE, deliberately: toggling
  // an order back to delivered must not restart the customer's window, and a
  // status flipped by mistake and corrected shouldn't hand them a fresh one.
  if (status === "delivered") {
    updateData.deliveredAt = sql`coalesce(${orders.deliveredAt}, now())`;
  }

  // customer_id is NULLABLE — an order can have no account behind it (a POS
  // walk-in). emitEvent takes that as "no customer audience", which is right:
  // there is nobody to tell.
  let updated: { order_ref: string; customer_id: string | null }[];
  try {
    updated = await withUser(admin, (db) =>
      db
        .update(orders)
        .set(updateData)
        .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
        // Returned so the event below can name the order and reach its owner
        // — the shopper is told about their own order, not just the staff.
        .returning({
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
        }),
    );
  } catch (err) {
    console.error("Error updating order status:", err);
    return { error: dbErrorMessage(err, "Failed to update order status.") };
  }

  const row = updated[0];
  if (row) {
    emitEvent({
      type: status === "cancelled" ? "order.cancelled" : "order.status_changed",
      storeId,
      actor: { type: "admin", id: admin.uid, label: admin.email },
      subject: { type: "order", id: orderId, label: row.order_ref },
      customerId: row.customer_id,
      payload: { status, ...(paymentStatus ? { paymentStatus } : {}) },
    });
  }

  revalidatePath("/dashboard/orders");
  return { success: true };
}

// ── Order detail (the slide-over drawer) ───────────────────────────────────

export interface OrderDetailItem {
  id: string;
  name: string;
  variant_name: string | null;
  price: number;
  quantity: number;
  total: number;
  tax_rate: number | null;
  /** Current product/variant thumbnail (best-effort; null if the product is gone). */
  image: string | null;
}

export interface OrderDetail {
  id: string;
  order_ref: string;
  order_no: number;
  created_at: string;
  updated_at: string;
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
  razorpay_payment_id: string | null;
  stock_status: string;
  /** 'delivery' for everything that isn't a collection. */
  fulfilment_type: string;
  pickup_status: string | null;
  pickup_ready_at: string | null;
  pickup_expires_at: string | null;
  pickup_location_name: string | null;
  /** The SHOP's address — `line1`/`city`/…, NOT the customer address shape
   *  (lib/locations/address.ts). */
  pickup_location_address: Record<string, unknown> | null;
  items: OrderDetailItem[];
}

const ORDER_DETAIL_COLUMNS = {
  id: orders.id,
  order_ref: orders.orderRef,
  order_no: orders.orderNo,
  created_at: orders.createdAt,
  updated_at: orders.updatedAt,
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
  razorpay_payment_id: orders.razorpayPaymentId,
  stock_status: orders.stockStatus,
  fulfilment_type: orders.fulfilmentType,
  pickup_status: orders.pickupStatus,
  pickup_ready_at: orders.pickupReadyAt,
  pickup_expires_at: orders.pickupExpiresAt,
  pickup_location_name: sql<string | null>`(
    select l.name from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
  pickup_location_address: sql<Record<string, unknown> | null>`(
    select l.address from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
};

/**
 * Full detail for one order (the dashboard drawer): the order row + its line
 * items, scoped to the acting store. Gated on the `orders` section.
 */
export async function getOrderDetail(
  orderId: string,
): Promise<{ order?: OrderDetail; error?: string }> {
  const userId = await getManagerUserId("orders");
  if (!userId) return { error: "Not authenticated" };
  if (typeof orderId !== "string" || !orderId.trim()) {
    return { error: "Invalid order." };
  }

  const storeId = await getActingStoreId();
  try {
    const result = await withService(async (db) => {
      const orderRows = await db
        .select(ORDER_DETAIL_COLUMNS)
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.storeId, storeId)))
        .limit(1);
      const order = orderRows[0];
      if (!order) return null;
      // Left-join products/variants for a current thumbnail (prefer the variant
      // image). Best-effort: a deleted product just yields a null image.
      const itemRows = await db
        .select({
          id: orderItems.id,
          name: orderItems.name,
          variant_name: orderItems.variantName,
          price: orderItems.price,
          quantity: orderItems.quantity,
          total: orderItems.total,
          tax_rate: orderItems.taxRate,
          product_image: products.imageUrl,
          variant_image: productVariants.imageUrl,
        })
        .from(orderItems)
        .leftJoin(products, eq(orderItems.productId, products.id))
        .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
        .where(eq(orderItems.orderId, orderId));
      const items = itemRows.map((r) => ({
        id: r.id,
        name: r.name,
        variant_name: r.variant_name,
        price: r.price,
        quantity: r.quantity,
        total: r.total,
        tax_rate: r.tax_rate,
        image: r.variant_image || r.product_image || null,
      }));
      return { ...order, items };
    });
    if (!result) return { error: "This order no longer exists." };
    return { order: result as unknown as OrderDetail };
  } catch (err) {
    console.error("getOrderDetail:", err instanceof Error ? err.message : err);
    return { error: dbErrorMessage(err, "Could not load the order.") };
  }
}
