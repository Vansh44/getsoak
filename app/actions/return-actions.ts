"use server";

// Returns you can ASK for (roadmap Step 3, docs/returns-exchanges-plan.md §11).
//
// Two callers, one file, because they are two ends of one object:
//   • the SHOPPER  — getReturnableOrder / requestReturn / cancelMyReturn
//   • the MERCHANT — getReturnQueue / reviewReturn / receiveReturn
//
// ── The trust boundary, same as placeOrder ─────────────────────────────────
// The client says WHICH lines and HOW MANY. It never says what they are worth,
// whether they are still returnable, or what the fee is — every one of those is
// recomputed here from the order's stored snapshot and the store's settings.
// `lib/pos/returns.ts`'s refundBreakdown does the money, and it already solves
// the order-discount re-allocation trap that makes a naive `total + tax`
// over-refund every discounted sale.
//
// ── What this does NOT do ──────────────────────────────────────────────────
// It never moves money. Approving a return says what is owed; a human still
// presses Refund on the order (§2.2, and the same rule cancellation follows).
// Exchanges are Step 4.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService, withUser } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  orderItems,
  orderReturnItems,
  orderReturns,
  orders,
  products,
} from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { getStoreSettings } from "@/lib/settings/resolve";
import { rateLimit } from "@/lib/rate-limit";
import { emitEvent } from "@/lib/notifications/record";
import { logError } from "@/lib/observability/logger";
import { refundBreakdown, remainingQty } from "@/lib/pos/returns";
import {
  feesFor,
  isReturnReason,
  RETURN_REASON_REGISTRY,
  type ReturnReason,
} from "@/lib/returns/reasons";
import {
  RETURN_BLOCKED_COPY,
  returnEligibility,
  type ReturnEligibility,
} from "@/lib/returns/eligibility";
import { reportStockChanges } from "@/lib/inventory/alerts";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ReturnableLineView {
  orderItemId: string;
  name: string;
  variantName: string | null;
  quantity: number;
  /** Already sent back on earlier returns. */
  returned: number;
  remaining: number;
  unitPrice: number;
  /** FALSE = final sale, this line can never come back. */
  returnable: boolean;
}

export interface ReturnableOrderView {
  orderId: string;
  orderRef: string | null;
  eligibility: ReturnEligibility;
  /** Customer-facing sentence when `eligibility.eligible` is false. */
  blockedCopy: string | null;
  lines: ReturnableLineView[];
  /** Store config the form needs — never a source of truth for the server. */
  requireReason: boolean;
  requirePhoto: boolean;
  restockingFeePercent: number;
  returnShippingFee: number;
  /** Returns this order already has, so the page can show their status. */
  existing: ExistingReturnView[];
}

export interface ExistingReturnView {
  id: string;
  status: string;
  createdAt: string | null;
  reasonCode: string | null;
  reviewNote: string | null;
  total: number;
  itemCount: number;
}

/** Statuses that still hold units — a line already inside one of these can't
 *  be requested again. A rejected or cancelled return frees them. */
const OPEN_STATUSES = ["requested", "approved", "received", "completed"];

// ---------------------------------------------------------------------------
// Customer — what can I send back?
// ---------------------------------------------------------------------------

export async function getReturnableOrder(
  orderId: string,
): Promise<{ view?: ReturnableOrderView; error?: string }> {
  const user = await getServerUser();
  if (!user) return { error: "Please sign in." };
  if (typeof orderId !== "string" || !orderId.trim()) {
    return { error: "Invalid order." };
  }
  const storeId = await requireStorefrontStoreId();
  const settings = await getStoreSettings();

  try {
    const identity = { uid: user.id, email: user.email ?? null };

    const orderRows = await withUser(identity, (db) =>
      db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          status: orders.status,
          discount: orders.discount,
          created_at: orders.createdAt,
          delivered_at: orders.deliveredAt,
          collected_at: orders.collectedAt,
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
    const order = orderRows[0];
    if (!order) return { error: "Not found." };

    const items = await withUser(identity, (db) =>
      db
        .select({
          id: orderItems.id,
          name: orderItems.name,
          variant_name: orderItems.variantName,
          quantity: orderItems.quantity,
          price: orderItems.price,
          total: orderItems.total,
          line_discount: orderItems.lineDiscount,
          tax_amount: orderItems.taxAmount,
          product_returnable: products.returnable,
          product_window: products.returnWindowDays,
        })
        .from(orderItems)
        .leftJoin(products, eq(products.id, orderItems.productId))
        .where(eq(orderItems.orderId, orderId))
        .orderBy(asc(orderItems.createdAt)),
    );

    const returnedByLine = await countReturnedUnits(
      orderId,
      items.map((i) => i.id),
    );
    const existing = await loadExistingReturns(identity, orderId);

    // Order-level eligibility uses the store's window; a per-product override
    // is applied per line below, because "eligible" is not one answer for a
    // basket whose items can carry different policies.
    const policy = {
      enabled: settings["returns.enabled"] === true,
      windowDays: Number(settings["returns.windowDays"]) || 0,
    };
    const orderInfo = {
      status: order.status,
      deliveredAt: order.delivered_at,
      collectedAt: order.collected_at,
      createdAt: order.created_at,
    };
    const eligibility = returnEligibility(orderInfo, null, policy);

    return {
      view: {
        orderId: order.id,
        orderRef: order.order_ref,
        eligibility,
        blockedCopy: eligibility.reason
          ? RETURN_BLOCKED_COPY[eligibility.reason]
          : null,
        lines: items.map((i) => {
          const returned = returnedByLine.get(i.id) ?? 0;
          const lineEligible = returnEligibility(
            orderInfo,
            {
              returnable: i.product_returnable,
              returnWindowDays: i.product_window,
            },
            policy,
          );
          return {
            orderItemId: i.id,
            name: i.name,
            variantName: i.variant_name,
            quantity: Number(i.quantity) || 0,
            returned,
            remaining: remainingQty({
              id: i.id,
              quantity: Number(i.quantity) || 0,
              lineTotal: Number(i.total) || 0,
              taxAmount: Number(i.tax_amount) || 0,
              alreadyReturned: returned,
            }),
            unitPrice: Number(i.price) || 0,
            returnable: lineEligible.eligible,
          };
        }),
        requireReason: settings["returns.requireReason"] === true,
        requirePhoto: settings["returns.requirePhotoForDamage"] === true,
        restockingFeePercent:
          Number(settings["returns.restockingFeePercent"]) || 0,
        returnShippingFee: Number(settings["returns.returnShippingFee"]) || 0,
        existing,
      },
    };
  } catch (err) {
    logError("returns: getReturnableOrder", err, { orderId });
    return { error: dbErrorMessage(err, "Couldn't load that order.") };
  }
}

/**
 * How many units of each line are spoken for by returns that are still alive.
 *
 * ★ Counts only OPEN statuses. A rejected or cancelled request must give its
 * units back, or one declined return would make those items unreturnable
 * forever — which is the exact opposite of what declining should mean.
 */
async function countReturnedUnits(
  orderId: string,
  orderItemIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderItemIds.length === 0) return out;
  try {
    const rows = await withService((db) =>
      db
        .select({
          order_item_id: orderReturnItems.orderItemId,
          qty: sql<number>`sum(${orderReturnItems.quantity})::int`,
        })
        .from(orderReturnItems)
        .innerJoin(orderReturns, eq(orderReturns.id, orderReturnItems.returnId))
        .where(
          and(
            eq(orderReturns.orderId, orderId),
            inArray(orderReturnItems.orderItemId, orderItemIds),
            inArray(orderReturns.status, OPEN_STATUSES),
          ),
        )
        .groupBy(orderReturnItems.orderItemId),
    );
    for (const r of rows) out.set(r.order_item_id, Number(r.qty) || 0);
  } catch (err) {
    // Fail CLOSED-ish: an empty map means "nothing returned yet", which would
    // let a line be requested twice. Better to surface nothing than to
    // double-count, so the caller sees zero remaining rather than everything.
    logError("returns: countReturnedUnits", err, { orderId });
    for (const id of orderItemIds) out.set(id, Number.MAX_SAFE_INTEGER);
  }
  return out;
}

async function loadExistingReturns(
  identity: { uid: string; email: string | null },
  orderId: string,
): Promise<ExistingReturnView[]> {
  try {
    const rows = await withUser(identity, (db) =>
      db
        .select({
          id: orderReturns.id,
          status: orderReturns.status,
          created_at: orderReturns.createdAt,
          reason_code: orderReturns.reasonCode,
          review_note: orderReturns.reviewNote,
          total: orderReturns.total,
          items: sql<number>`(
            select coalesce(sum(ri.quantity), 0)::int
              from order_return_items ri
             where ri.return_id = ${orderReturns.id}
          )`,
        })
        .from(orderReturns)
        .where(eq(orderReturns.orderId, orderId))
        .orderBy(desc(orderReturns.createdAt)),
    );
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      reasonCode: r.reason_code,
      reviewNote: r.review_note,
      total: Number(r.total ?? 0),
      itemCount: Number(r.items) || 0,
    }));
  } catch (err) {
    logError("returns: loadExistingReturns", err, { orderId });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Customer — ask to send it back
// ---------------------------------------------------------------------------

export interface RequestReturnLine {
  orderItemId: string;
  quantity: number;
}

export interface RequestReturnResult {
  returnId?: string;
  /** Auto-approved without a human — see the autoApprove rule below. */
  autoApproved?: boolean;
  /** What they'd get back, after fees. Display only. */
  refundAmount?: number;
  error?: string;
}

export async function requestReturn(input: {
  orderId: string;
  lines: RequestReturnLine[];
  reasonCode?: string;
  note?: string;
  photos?: string[];
}): Promise<RequestReturnResult> {
  const user = await getServerUser();
  if (!user) return { error: "Please sign in." };
  const { orderId } = input;
  if (typeof orderId !== "string" || !orderId.trim()) {
    return { error: "Invalid order." };
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { error: "Choose what you'd like to send back." };
  }

  const storeId = await requireStorefrontStoreId();
  const settings = await getStoreSettings();

  // Server-side gates. A rendered form is not a permission (invariant 5).
  if (settings["returns.enabled"] !== true) {
    return { error: "This store doesn't accept returns online." };
  }
  if (settings["returns.selfServe"] !== true) {
    return {
      error: "Please contact the store to arrange a return.",
    };
  }

  const { allowed } = await rateLimit(`return:${user.id}`, {
    max: 10,
    windowSeconds: 3600,
  });
  if (!allowed)
    return { error: "Too many attempts. Please try again shortly." };

  const reasonCode = isReturnReason(input.reasonCode) ? input.reasonCode : null;
  if (settings["returns.requireReason"] === true && !reasonCode) {
    return { error: "Please tell us why it's coming back." };
  }

  // Re-read everything. The form's numbers are a starting point, not input.
  const { view, error } = await getReturnableOrder(orderId);
  if (error || !view) return { error: error ?? "Couldn't load that order." };
  if (!view.eligibility.eligible) {
    return {
      error: view.blockedCopy ?? "This order can't be returned.",
    };
  }

  const lineById = new Map(view.lines.map((l) => [l.orderItemId, l]));
  const requested: RequestReturnLine[] = [];
  for (const l of input.lines) {
    const line = lineById.get(l.orderItemId);
    if (!line) continue;
    const qty = Math.min(
      Math.max(0, Math.trunc(Number(l.quantity) || 0)),
      line.remaining,
    );
    if (qty <= 0) continue;
    // ★ A final-sale line is refused even if the client sent it. The form
    // disables it; the server is the boundary.
    if (!line.returnable) {
      return {
        error: `"${line.name}" can't be returned.`,
      };
    }
    requested.push({ orderItemId: l.orderItemId, quantity: qty });
  }
  if (requested.length === 0) {
    return { error: "Nothing on this order is still returnable." };
  }

  const { breakdown, fees } = await priceReturn(
    orderId,
    requested,
    reasonCode,
    settings,
  );
  if (!breakdown || breakdown.total <= 0) {
    return { error: "Nothing on this order is still returnable." };
  }

  // ★ AUTO-APPROVE NEVER COVERS A FAULT CLAIM.
  // "Arrived damaged" waives every fee, so auto-approving it lets anyone opt
  // out of a store's return charges by picking the right radio button. Those
  // always go to a person. This is not a setting — it is what makes
  // `returns.autoApprove` safe to offer at all (§2.4).
  const claimsFault =
    reasonCode !== null && RETURN_REASON_REGISTRY[reasonCode].merchantFault;
  const autoApprove = settings["returns.autoApprove"] === true && !claimsFault;

  const photos = sanitizePhotos(input.photos);
  const note = input.note?.trim().slice(0, 500) || null;

  let returnId: string;
  try {
    returnId = await withService(async (db) => {
      const inserted = await db
        .insert(orderReturns)
        .values({
          storeId,
          orderId,
          status: autoApprove ? "approved" : "requested",
          channel: "online",
          requestedBy: user.id,
          reasonCode,
          reason: note,
          photos,
          amount: breakdown.amount,
          tax: breakdown.tax,
          // Net of fees — what the customer would actually receive.
          total: Math.max(0, breakdown.total - fees.totalDeduction),
          restockingFee: fees.restockingFee,
          returnShippingFee: fees.returnShippingFee,
          actor: user.email ?? user.id,
          ...(autoApprove
            ? { reviewedAt: new Date().toISOString(), reviewedBy: "system" }
            : {}),
        })
        .returning({ id: orderReturns.id });
      const id = inserted[0]!.id;

      await db.insert(orderReturnItems).values(
        breakdown.lines.map((l) => ({
          returnId: id,
          orderItemId: l.id,
          quantity: l.quantity,
          amount: l.amount,
          tax: l.tax,
          total: l.total,
          // Decided when the goods are actually in front of someone.
          condition: "sellable",
          restocked: false,
        })),
      );
      return id;
    });
  } catch (err) {
    logError("returns: requestReturn", err, { orderId });
    return { error: dbErrorMessage(err, "Couldn't start that return.") };
  }

  const refundAmount = Math.max(0, breakdown.total - fees.totalDeduction);

  emitEvent({
    type: autoApprove ? "order.return_approved" : "order.return_requested",
    storeId,
    actor: { type: "customer", id: user.id, label: user.email ?? null },
    subject: { type: "order", id: orderId, label: view.orderRef },
    customerId: user.id,
    payload: {
      orderRef: view.orderRef ?? "",
      currency: "INR",
      refund_amount: refundAmount,
      fees: fees.totalDeduction,
      items: breakdown.lines.reduce((n, l) => n + l.quantity, 0),
      ...(reasonCode
        ? { reason: RETURN_REASON_REGISTRY[reasonCode].label }
        : {}),
    },
  });

  revalidatePath(`/orders/${orderId}`);
  return { returnId, autoApproved: autoApprove, refundAmount };
}

/** Price a set of lines and work out the deduction, from stored data only. */
async function priceReturn(
  orderId: string,
  lines: RequestReturnLine[],
  reasonCode: ReturnReason | null,
  settings: Record<string, boolean | number>,
) {
  const rows = await withService((db) =>
    db
      .select({
        id: orderItems.id,
        quantity: orderItems.quantity,
        total: orderItems.total,
        line_discount: orderItems.lineDiscount,
        tax_amount: orderItems.taxAmount,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId)),
  );
  const orderRow = await withService((db) =>
    db
      .select({ discount: orders.discount })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1),
  );

  const returned = await countReturnedUnits(
    orderId,
    rows.map((r) => r.id),
  );

  // The ORDER-level discount only: line markdowns are already inside each
  // line's total, so `orders.discount` minus them is what must be
  // re-allocated (lib/pos/returns.ts).
  const lineDiscountTotal = rows.reduce(
    (sum, r) => sum + (Number(r.line_discount) || 0),
    0,
  );
  const orderDiscount = Math.max(
    0,
    (Number(orderRow[0]?.discount) || 0) - lineDiscountTotal,
  );

  const breakdown = refundBreakdown({
    lines: rows.map((r) => ({
      id: r.id,
      quantity: Number(r.quantity) || 0,
      lineTotal: Number(r.total) || 0,
      taxAmount: Number(r.tax_amount) || 0,
      alreadyReturned: returned.get(r.id) ?? 0,
    })),
    orderDiscount,
    request: lines.map((l) => ({ id: l.orderItemId, quantity: l.quantity })),
  });

  // Fees are charged on the GOODS, never on the tax — that share belongs to
  // the government, not the store.
  const fees = feesFor(
    reasonCode,
    {
      restockingFeePercent:
        Number(settings["returns.restockingFeePercent"]) || 0,
      returnShippingFee: Number(settings["returns.returnShippingFee"]) || 0,
    },
    breakdown.amount,
  );

  return { breakdown, fees };
}

/** GCS URLs only, capped. Photos ride into a jsonb column that the dashboard
 *  renders — an arbitrary string here would be an image-tag injection. */
function sanitizePhotos(photos: unknown): string[] {
  if (!Array.isArray(photos)) return [];
  return photos
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("https://storage.googleapis.com/"))
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// Customer — change my mind about the request
// ---------------------------------------------------------------------------

export async function cancelMyReturn(
  returnId: string,
): Promise<{ ok?: boolean; error?: string }> {
  const user = await getServerUser();
  if (!user) return { error: "Please sign in." };
  const storeId = await requireStorefrontStoreId();

  try {
    // The WHERE is the authority: their own request, on this store, still
    // waiting. Once a store has approved it, withdrawing is a conversation.
    const claimed = await withService((db) =>
      db
        .update(orderReturns)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(orderReturns.id, returnId),
            eq(orderReturns.storeId, storeId),
            eq(orderReturns.requestedBy, user.id),
            eq(orderReturns.status, "requested"),
          ),
        )
        .returning({ id: orderReturns.id, order_id: orderReturns.orderId }),
    );
    if (!claimed.length) {
      return { error: "That request can no longer be withdrawn." };
    }
    revalidatePath(`/orders/${claimed[0]!.order_id}`);
    return { ok: true };
  } catch (err) {
    logError("returns: cancelMyReturn", err, { returnId });
    return { error: "Couldn't withdraw that request." };
  }
}

// ---------------------------------------------------------------------------
// Merchant — the review queue
// ---------------------------------------------------------------------------

export interface ReturnQueueRow {
  id: string;
  orderId: string;
  orderRef: string | null;
  status: string;
  channel: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  /** TRUE when the reason blames the store — these carry no fees and should
   *  be looked at first. */
  merchantFault: boolean;
  customerNote: string | null;
  photos: string[];
  total: number;
  restockingFee: number;
  returnShippingFee: number;
  itemCount: number;
  createdAt: string | null;
  reviewNote: string | null;
}

export async function getReturnQueue(
  status?: string,
): Promise<{ rows: ReturnQueueRow[]; error?: string }> {
  const admin = await getManagerIdentity("orders");
  if (!admin) return { rows: [], error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const filter =
    status && OPEN_STATUSES.concat("rejected", "cancelled").includes(status)
      ? [eq(orderReturns.status, status)]
      : [inArray(orderReturns.status, OPEN_STATUSES)];

  try {
    const rows = await withUser(admin, (db) =>
      db
        .select({
          id: orderReturns.id,
          order_id: orderReturns.orderId,
          order_ref: orders.orderRef,
          status: orderReturns.status,
          channel: orderReturns.channel,
          reason_code: orderReturns.reasonCode,
          customer_note: orderReturns.reason,
          photos: orderReturns.photos,
          total: orderReturns.total,
          restocking_fee: orderReturns.restockingFee,
          return_shipping_fee: orderReturns.returnShippingFee,
          created_at: orderReturns.createdAt,
          review_note: orderReturns.reviewNote,
          items: sql<number>`(
            select coalesce(sum(ri.quantity), 0)::int
              from order_return_items ri
             where ri.return_id = ${orderReturns.id}
          )`,
        })
        .from(orderReturns)
        .innerJoin(orders, eq(orders.id, orderReturns.orderId))
        .where(and(eq(orderReturns.storeId, storeId), ...filter))
        .orderBy(asc(orderReturns.createdAt))
        .limit(200),
    );

    return {
      rows: rows.map((r) => {
        const code = isReturnReason(r.reason_code) ? r.reason_code : null;
        return {
          id: r.id,
          orderId: r.order_id,
          orderRef: r.order_ref,
          status: r.status,
          channel: r.channel,
          reasonCode: code,
          reasonLabel: code ? RETURN_REASON_REGISTRY[code].label : null,
          merchantFault: code
            ? RETURN_REASON_REGISTRY[code].merchantFault
            : false,
          customerNote: r.customer_note,
          photos: Array.isArray(r.photos) ? (r.photos as string[]) : [],
          total: Number(r.total ?? 0),
          restockingFee: Number(r.restocking_fee ?? 0),
          returnShippingFee: Number(r.return_shipping_fee ?? 0),
          itemCount: Number(r.items) || 0,
          createdAt: r.created_at,
          reviewNote: r.review_note,
        };
      }),
    };
  } catch (err) {
    logError("returns: getReturnQueue", err, { storeId });
    return { rows: [], error: dbErrorMessage(err, "Couldn't load returns.") };
  }
}

// ---------------------------------------------------------------------------
// Merchant — decide
// ---------------------------------------------------------------------------

export async function reviewReturn(
  returnId: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const admin = await getManagerIdentity("orders");
  if (!admin) return { error: "Not authenticated" };
  if (decision !== "approve" && decision !== "reject") {
    return { error: "Invalid decision." };
  }
  const storeId = await getActingStoreId();
  const reviewNote = note?.trim().slice(0, 500) || null;

  // ★ A rejection MUST carry a reason. A silent no is the single most
  // complained-about thing a returns process can do, and the customer sees
  // this text verbatim.
  if (decision === "reject" && !reviewNote) {
    return { error: "Tell the customer why you're declining this." };
  }

  try {
    // Conditional claim: only a request still waiting can be decided, so two
    // admins clicking at once produce one decision rather than two.
    const claimed = await withService((db) =>
      db
        .update(orderReturns)
        .set({
          status: decision === "approve" ? "approved" : "rejected",
          reviewedBy: admin.email ?? admin.uid,
          reviewedAt: new Date().toISOString(),
          reviewNote,
        })
        .where(
          and(
            eq(orderReturns.id, returnId),
            eq(orderReturns.storeId, storeId),
            eq(orderReturns.status, "requested"),
          ),
        )
        .returning({
          id: orderReturns.id,
          order_id: orderReturns.orderId,
          total: orderReturns.total,
          restocking_fee: orderReturns.restockingFee,
          return_shipping_fee: orderReturns.returnShippingFee,
        }),
    );
    if (!claimed.length) {
      return { error: "That return has already been decided." };
    }
    const row = claimed[0]!;

    const order = await withService((db) =>
      db
        .select({
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
        })
        .from(orders)
        .where(eq(orders.id, row.order_id))
        .limit(1),
    );

    emitEvent({
      type:
        decision === "approve"
          ? "order.return_approved"
          : "order.return_rejected",
      storeId,
      actor: { type: "admin", id: admin.uid, label: admin.email },
      subject: {
        type: "order",
        id: row.order_id,
        label: order[0]?.order_ref ?? null,
      },
      customerId: order[0]?.customer_id ?? null,
      payload: {
        orderRef: order[0]?.order_ref ?? "",
        currency: "INR",
        ...(decision === "approve"
          ? {
              refund_amount: Number(row.total ?? 0),
              fees:
                Number(row.restocking_fee ?? 0) +
                Number(row.return_shipping_fee ?? 0),
            }
          : {}),
        ...(reviewNote ? { note: reviewNote } : {}),
      },
    });

    revalidatePath("/dashboard/orders/returns");
    return { ok: true };
  } catch (err) {
    logError("returns: reviewReturn", err, { returnId });
    return { error: dbErrorMessage(err, "Couldn't record that decision.") };
  }
}

// ---------------------------------------------------------------------------
// Merchant — the goods arrived
// ---------------------------------------------------------------------------

export interface ReceiveLineInput {
  orderItemId: string;
  condition: "sellable" | "damaged";
}

/**
 * Book the goods back in.
 *
 * ★ ONLY `sellable` UNITS REACH THE SHELF. A dented tin coming back is not
 * stock, and restocking it is how a shop sells the same broken thing twice.
 * The condition is decided HERE, with the goods in front of someone — never at
 * request time, when nobody has seen them.
 *
 * It does NOT refund. What is owed shows on the order (§26's `refundOwed`),
 * and a human presses the button — the same rule cancellation follows.
 */
export async function receiveReturn(
  returnId: string,
  lines: ReceiveLineInput[],
): Promise<{ ok?: boolean; restocked?: number; error?: string }> {
  const admin = await getManagerIdentity("orders");
  if (!admin) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const conditionOf = new Map(
    (Array.isArray(lines) ? lines : []).map((l) => [
      l.orderItemId,
      l.condition === "damaged" ? "damaged" : "sellable",
    ]),
  );

  try {
    // Only an APPROVED return can be received — goods arriving for something
    // nobody agreed to is a conversation, not a stock movement.
    const claimed = await withService((db) =>
      db
        .update(orderReturns)
        .set({ status: "received", receivedAt: new Date().toISOString() })
        .where(
          and(
            eq(orderReturns.id, returnId),
            eq(orderReturns.storeId, storeId),
            eq(orderReturns.status, "approved"),
          ),
        )
        .returning({
          id: orderReturns.id,
          order_id: orderReturns.orderId,
          location_id: orderReturns.locationId,
        }),
    );
    if (!claimed.length) {
      return { error: "That return isn't waiting to be received." };
    }
    const ret = claimed[0]!;

    const items = await withService((db) =>
      db
        .select({
          id: orderReturnItems.id,
          order_item_id: orderReturnItems.orderItemId,
          quantity: orderReturnItems.quantity,
          product_id: orderItems.productId,
          variant_id: orderItems.variantId,
        })
        .from(orderReturnItems)
        .innerJoin(orderItems, eq(orderItems.id, orderReturnItems.orderItemId))
        .where(eq(orderReturnItems.returnId, returnId)),
    );

    const restocked: string[] = [];
    const deltas: {
      productId: string;
      variantId: string | null;
      delta: number;
    }[] = [];

    for (const item of items) {
      const condition = conditionOf.get(item.order_item_id) ?? "sellable";
      await withService((db) =>
        db
          .update(orderReturnItems)
          .set({ condition })
          .where(eq(orderReturnItems.id, item.id)),
      ).catch((err) => logError("returns: condition write", err, { returnId }));

      if (condition !== "sellable" || !item.product_id) continue;

      try {
        // The location the goods came back TO. Null for an online return the
        // merchant handled from the desk, in which case the wrapper sends it
        // to the store's default — the same rule online orders reserve under.
        await withService((db) =>
          db.execute(
            ret.location_id
              ? sql`select adjust_stock_at(p_store => ${storeId}, p_location => ${ret.location_id}, p_product => ${item.product_id}, p_variant => ${item.variant_id || null}, p_delta => ${item.quantity}, p_reason => ${"return"}, p_note => ${`Return ${returnId.slice(0, 8)}`}, p_actor => ${admin.email ?? admin.uid}) as new_stock`
              : sql`select adjust_stock(p_store => ${storeId}, p_product => ${item.product_id}, p_variant => ${item.variant_id || null}, p_delta => ${item.quantity}, p_reason => ${"return"}, p_note => ${`Return ${returnId.slice(0, 8)}`}, p_actor => ${admin.email ?? admin.uid}) as new_stock`,
          ),
        );
        restocked.push(item.id);
        deltas.push({
          productId: item.product_id,
          variantId: item.variant_id,
          delta: item.quantity,
        });
      } catch (err) {
        // The goods ARE on the shelf by now — a failed ledger write must not
        // undo that or block the rest of the return. It shows up in the next
        // count, which is recoverable; an unrecorded return is not.
        logError("returns: restock", err, { returnId });
      }
    }

    if (restocked.length) {
      await withService((db) =>
        db
          .update(orderReturnItems)
          .set({ restocked: true })
          .where(inArray(orderReturnItems.id, restocked)),
      ).catch((err) => logError("returns: restock flag", err, { returnId }));

      // Coming back on the shelf can cross a low-stock threshold in reverse —
      // the same reporting a sale does, with a positive delta.
      reportStockChanges(storeId, deltas);
    }

    revalidatePath("/dashboard/orders/returns");
    return { ok: true, restocked: restocked.length };
  } catch (err) {
    logError("returns: receiveReturn", err, { returnId });
    return { error: dbErrorMessage(err, "Couldn't book that return in.") };
  }
}
