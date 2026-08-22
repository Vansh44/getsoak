"use server";

// The collection queue at a shop (roadmap Phase F).
//
// A pickup order's stock is HELD at this location, not sold. Handing it over is
// what turns the hold into a sale — which is why collection goes through
// `commitHold` rather than touching stock directly (roadmap invariant 1).
//
// Everything is scoped to the OPERATOR's location. A cashier at Delhi hands over
// Delhi's orders; naming another shop is not possible because the location is
// never taken from the client.
//
// ★ A `pay_at_store` collection is also where MONEY changes hands, and until
// 2026-08-06 none of it was recorded: the hand-over flipped payment_status to
// 'paid' and wrote no `order_payments` row and no `orders.shift_id`. Shift
// reconciliation then read cash by joining payments through orders.shift_id,
// so the notes were physically in the drawer and contributed 0 to expectedCash
// — every drawer reported OVER by the full value of every collection it took,
// every shift, and those sales were missing from the Z-report's count and gross
// as well. That is the mirror of the two bugs lib/pos/shifts.ts already guards
// (double-counted change, cash refunds), which both reported SHORT. Takings now
// use the tender's own order_payments.shift_id; orders.shift_id remains the
// completed-sale attribution.

import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import {
  orderItems,
  orderPayments,
  orders,
  stockReservations,
  storeLocations,
} from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { commitHold } from "@/lib/inventory/reservations";
import { emitEvent } from "@/lib/notifications/record";
import { formatAddressLine } from "@/lib/locations/address";
import {
  formatCollectionCode,
  isCollectionCode,
  normalizeCollectionCode,
} from "@/lib/fulfilment/collection-code";
import { amountDueAtCollection } from "@/lib/pos/pickup-payment";
import { coversTotal } from "@/lib/pos/totals";
import {
  accountTenderTotal,
  settleTenders,
  validateTenderShape,
  COUNTER_TENDER_METHODS,
  type PosTender,
} from "@/lib/pos/tenders";
import { verifyGatewayTenders } from "@/lib/payments/pos-gateway";
import { getCreditBalance, spendCredit } from "@/lib/credit/store-credit";
import { currentShiftIdFor } from "./pos-shift-actions";
import { getStoreSettings } from "@/lib/settings/resolve";
import { handoverGate } from "@/lib/pos/collection-state";

/**
 * The shop an order is waiting at, returned alongside the claim itself.
 *
 * Both hand-over paths tell the customer something about WHERE, so both read
 * it the same way — and reading it in the same statement that claims the row
 * means the name can't be fetched for an order the claim didn't actually win.
 */
const pickupShopColumns = {
  location_name: sql<string | null>`(
    select l.name from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
  location_address: sql<Record<string, unknown> | null>`(
    select l.address from ${storeLocations} l where l.id = ${orders.pickupLocationId}
  )`,
};

export interface PickupOrder {
  id: string;
  orderRef: string;
  customerName: string | null;
  itemCount: number;
  total: number;
  /** Still owed at the counter — 0 when it was paid online. Drives whether the
   *  queue takes a payment before handing over. */
  amountDue: number;
  placedAt: string;
  expiresAt: string | null;
  status: string;
  /** Deposits already taken at the counter. 0 for almost every order; shown on
   *  the row so a part-paid collection is visible rather than inferred from a
   *  smaller `amountDue`. */
  paidSoFar: number;
}

function fail(msg: string) {
  return { orders: [] as PickupOrder[], error: msg };
}

/**
 * What has already been taken at the counter, per order (roadmap Step 18).
 *
 * ★ ONE READER, so the queue, a scanned code and the charge itself cannot
 * disagree about what a customer still owes. Empty map on failure, which reads
 * as "nothing paid" — the safe direction: it asks for the full amount rather
 * than handing goods over against a deposit that may not exist.
 */
async function paidSoFarFor(orderIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  try {
    const rows = await withService((db) =>
      db
        .select({
          order_id: orderPayments.orderId,
          paid: sql<string>`coalesce(sum(${orderPayments.amount}), 0)`,
        })
        .from(orderPayments)
        .where(inArray(orderPayments.orderId, orderIds))
        .groupBy(orderPayments.orderId),
    );
    for (const r of rows) out.set(r.order_id, Number(r.paid) || 0);
  } catch (err) {
    console.error("paidSoFarFor:", err);
  }
  return out;
}

/**
 * Record a DEPOSIT: money taken at the counter that does not settle the order.
 *
 * ★★ NO CLAIM, AND THAT IS THE WHOLE DESIGN. `markCollected`'s claim is
 * awaiting|ready → collected, and a part-paid collection is neither. Rather
 * than invent a third pickup state, this records the payment and leaves the
 * order exactly where it was: the shop holds the deposit AND the parcel, and
 * the customer collects when they settle (owner, 2026-08-18).
 *
 * ★ THE CAP IS THE INVARIANT WORTH HAVING. Recorded payments can never exceed
 * what the order owes — re-read inside the same transaction that writes, so a
 * slow double-tap cannot walk the total past the order's value. Combined with
 * `paidSoFar` on the row, a duplicate is visible rather than silent.
 *
 * ⚠ IT IS NOT IDEMPOTENT, and neither is the sell counter: two deliberate taps
 * on "take ₹200" record ₹200 twice, capped at the amount owed. That is the
 * till's existing posture — the human sees the outcome — and the cap bounds the
 * damage to the order's own total instead of unbounded drawer inflation.
 */
async function takeDeposit(input: {
  op: { storeId: string; locationId: string; staffId: string | null };
  orderId: string;
  tenders: PosTender[];
  paid: number;
  shiftId: string | null;
}): Promise<{
  success?: boolean;
  error?: string;
  partial?: { paid: number; remaining: number };
}> {
  const { op, orderId, tenders, paid, shiftId } = input;
  try {
    const remaining = await withService(async (db) => {
      // Lock the ORDER before reading the tender total. Every deposit and the
      // final claim take this same lock, so two counters cannot both approve
      // against the same stale balance.
      const lockedRows = await db
        .select({
          total: orders.total,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
        })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            eq(orders.fulfilmentType, "pickup"),
            eq(orders.pickupLocationId, op.locationId),
            or(
              eq(orders.pickupStatus, "awaiting"),
              eq(orders.pickupStatus, "ready"),
            ),
          ),
        )
        .limit(1)
        .for("update");
      const locked = lockedRows[0];
      if (!locked) throw new Error(NOT_WAITING_CODE);

      const nowRows = await db
        .select({
          paid: sql<string>`coalesce(sum(${orderPayments.amount}), 0)`,
        })
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));
      const settledNow = Number(nowRows[0]?.paid) || 0;
      const owedNow = amountDueAtCollection({
        paymentMethod: locked.payment_method,
        paymentStatus: locked.payment_status,
        total: locked.total,
        paidSoFar: settledNow,
      });
      if (paid > owedNow + 0.0001) {
        throw new Error(OVERPAID);
      }
      // This request entered as a deposit. If another tender has meanwhile
      // made it a full settlement, make the cashier reload and use the claim
      // path; silently leaving a fully paid parcel on the shelf is misleading.
      if (paid + 0.0001 >= owedNow) throw new Error(PAYMENT_MOVED);

      await db.insert(orderPayments).values(
        tenders.map((t) => ({
          orderId,
          storeId: op.storeId,
          shiftId,
          method: t.method,
          amount: t.amount,
          tendered: t.method === "cash" ? (t.tendered ?? t.amount) : null,
          // ★ NO CHANGE ON A DEPOSIT. Change comes out of an OVER-payment, and
          // a deposit is by definition short — handing money back here would be
          // taking it straight out of the drawer.
          changeDue: null,
          reference: t.reference?.slice(0, 120) ?? null,
        })),
      );
      return Math.max(0, owedNow - paid);
    });

    revalidatePath("/pos/pickups");
    return { success: true, partial: { paid, remaining } };
  } catch (err) {
    if (err instanceof Error && err.message === OVERPAID) {
      return {
        error:
          "That is more than this order still owes — someone may have just taken a payment. Reload and check.",
      };
    }
    if (err instanceof Error && err.message === PAYMENT_MOVED) {
      return {
        error:
          "This order's payment changed while you were taking it. Reload and check the remaining balance.",
      };
    }
    if (err instanceof Error && err.message === NOT_WAITING_CODE) {
      return { error: NOT_WAITING };
    }
    return { error: dbErrorMessage(err, "Couldn't record that payment.") };
  }
}

/** Orders waiting to be collected at THIS shop, oldest first. */
export async function getPickupQueue(
  query?: string,
): Promise<{ orders: PickupOrder[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return fail("Not signed in.");
  if (!posCan(op.role, "sell")) return fail("Not allowed.");

  const q = (query ?? "").trim().slice(0, 60);

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          shipping_address: orders.shippingAddress,
          total: orders.total,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          created_at: orders.createdAt,
          expires_at: orders.pickupExpiresAt,
          status: orders.pickupStatus,
        })
        .from(orders)
        .where(
          and(
            eq(orders.storeId, op.storeId),
            eq(orders.fulfilmentType, "pickup"),
            eq(orders.pickupLocationId, op.locationId),
            // Collected and expired orders leave the queue — it is a list of
            // work, not a history.
            or(
              eq(orders.pickupStatus, "awaiting"),
              eq(orders.pickupStatus, "ready"),
            ),
            q
              ? ilike(orders.orderRef, `%${q.replace(/[%_]/g, "\\$&")}%`)
              : undefined,
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(100),
    );

    // Counted separately, not as a correlated subquery: interpolating columns
    // into sql`` drops their table qualification, so `where "order_id" = "id"`
    // resolves both names inside order_items and silently counts zero.
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const countRows = await withService((db) =>
        db
          .select({ order_id: orderItems.orderId, n: count() })
          .from(orderItems)
          .where(
            inArray(
              orderItems.orderId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(orderItems.orderId),
      );
      for (const c of countRows) counts.set(c.order_id, Number(c.n) || 0);
    }
    const deposits = await paidSoFarFor(rows.map((r) => r.id));

    return {
      orders: rows.map((r) => {
        const addr = (r.shipping_address ?? {}) as Record<string, unknown>;
        const name =
          [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() ||
          null;
        return {
          id: r.id,
          orderRef: r.order_ref ?? "",
          customerName: name,
          itemCount: counts.get(r.id) ?? 0,
          total: Number(r.total) || 0,
          // The SAME helper markCollected charges with, so the counter can
          // never quote one figure and take another.
          amountDue: amountDueAtCollection({
            paymentMethod: r.payment_method,
            paymentStatus: r.payment_status,
            total: r.total,
            paidSoFar: deposits.get(r.id) ?? 0,
          }),
          paidSoFar: deposits.get(r.id) ?? 0,
          placedAt: r.created_at,
          expiresAt: r.expires_at,
          status: r.status ?? "awaiting",
        };
      }),
    };
  } catch (err) {
    return fail(dbErrorMessage(err, "Couldn't load the collection queue."));
  }
}

export interface PickupDetailLine {
  name: string;
  variantName: string | null;
  quantity: number;
  /** Unit price BEFORE any line markdown, so "2 × ₹100 … less ₹30" adds up. */
  price: number;
  lineDiscount: number;
  total: number;
}

export interface PickupDetailPayment {
  method: string;
  amount: number;
  reference: string | null;
  capturedAt: string;
}

export interface PickupDetail extends PickupOrder {
  collectionCode: string | null;
  customerPhone: string | null;
  readyAt: string | null;
  collectedAt: string | null;
  lines: PickupDetailLine[];
  subtotal: number;
  discount: number;
  tax: number;
  taxInclusive: boolean;
  shipping: number;
  /** A PAYMENT, not a discount (§29) — shown under what was paid, never
   *  subtracted from the totals ladder, or the invoice and this screen would
   *  quote different sale values for the same order. */
  storeCreditUsed: number;
  paymentMethod: string | null;
  paymentStatus: string | null;
  /** Only ever written by the COUNTER. Online checkout records no payment row,
   *  so an empty list here does not mean the customer has paid nothing. */
  payments: PickupDetailPayment[];
}

/**
 * ONE collection, fully described — its goods, what has been paid, what is
 * still owed.
 *
 * ★ WHY THIS EXISTS. The queue row carried a total, an item COUNT and a badge,
 * and nothing else. A cashier facing a customer asking "which pair is this?" or
 * "didn't I leave a deposit?" could not answer from the till — they could see
 * the money and not the goods. Handing a parcel over is the one irreversible
 * act at this counter, so being unable to look inside it first is the wrong way
 * round.
 *
 * ★ NO STATUS FILTER, deliberately — `findPickupByCode`'s rule. The queue is a
 * list of WORK and drops collected and expired orders; this is a LOOKUP, and a
 * customer standing at the counter holding a cancelled order is exactly when
 * the shop most needs to be able to say what happened. `collectionState` on the
 * client then decides what may still be DONE with it.
 *
 * ★ SCOPED TO THE OPERATOR'S SHOP, never to an id from the client — the same
 * three predicates the queue uses, so pasting a UUID cannot describe another
 * branch's collection.
 */
export async function getPickupOrderDetail(
  orderId: string,
): Promise<{ detail?: PickupDetail; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid order." };

  try {
    const row = await withService(async (db) => {
      const found = await db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          pickup_code: orders.pickupCode,
          shipping_address: orders.shippingAddress,
          subtotal: orders.subtotal,
          discount: orders.discount,
          tax: orders.tax,
          tax_inclusive: orders.taxInclusive,
          shipping: orders.shipping,
          store_credit_used: orders.storeCreditUsed,
          total: orders.total,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          created_at: orders.createdAt,
          expires_at: orders.pickupExpiresAt,
          ready_at: orders.pickupReadyAt,
          collected_at: orders.collectedAt,
          status: orders.pickupStatus,
        })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            eq(orders.fulfilmentType, "pickup"),
            eq(orders.pickupLocationId, op.locationId),
          ),
        )
        .limit(1);
      return found[0] ?? null;
    });

    if (!row) return { error: "That order isn't a collection at this shop." };

    // Separate round trips rather than one transaction: they are independent,
    // and statements inside a single withService share a client and run
    // SERIALLY (the §22 Step 20 finding).
    const [lines, payments, deposits] = await Promise.all([
      withService((db) =>
        db
          .select({
            name: orderItems.name,
            variant_name: orderItems.variantName,
            quantity: orderItems.quantity,
            price: orderItems.price,
            line_discount: orderItems.lineDiscount,
            total: orderItems.total,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId)),
      ),
      withService((db) =>
        db
          .select({
            method: orderPayments.method,
            amount: orderPayments.amount,
            reference: orderPayments.reference,
            captured_at: orderPayments.capturedAt,
          })
          .from(orderPayments)
          .where(eq(orderPayments.orderId, orderId))
          .orderBy(asc(orderPayments.capturedAt)),
      ),
      paidSoFarFor([orderId]),
    ]);

    const addr = (row.shipping_address ?? {}) as Record<string, unknown>;
    const name =
      [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() || null;
    const phone = typeof addr.phone === "string" ? addr.phone : null;
    const paidSoFar = deposits.get(orderId) ?? 0;

    return {
      detail: {
        id: row.id,
        orderRef: row.order_ref ?? "",
        collectionCode: row.pickup_code
          ? formatCollectionCode(row.pickup_code)
          : null,
        customerName: name,
        customerPhone: phone,
        itemCount: lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0),
        subtotal: Number(row.subtotal) || 0,
        discount: Number(row.discount) || 0,
        tax: Number(row.tax) || 0,
        taxInclusive: Boolean(row.tax_inclusive),
        shipping: Number(row.shipping) || 0,
        storeCreditUsed: Number(row.store_credit_used) || 0,
        total: Number(row.total) || 0,
        // The SAME helper the queue quotes and markCollected charges.
        amountDue: amountDueAtCollection({
          paymentMethod: row.payment_method,
          paymentStatus: row.payment_status,
          total: row.total,
          paidSoFar,
        }),
        paidSoFar,
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status,
        placedAt: row.created_at,
        expiresAt: row.expires_at,
        readyAt: row.ready_at,
        collectedAt: row.collected_at,
        status: row.status ?? "awaiting",
        lines: lines.map((l) => ({
          name: l.name ?? "Item",
          variantName: l.variant_name ?? null,
          quantity: Number(l.quantity) || 0,
          price: Number(l.price) || 0,
          lineDiscount: Number(l.line_discount) || 0,
          total: Number(l.total) || 0,
        })),
        payments: payments.map((p) => ({
          method: p.method ?? "",
          amount: Number(p.amount) || 0,
          reference: p.reference ?? null,
          capturedAt: p.captured_at,
        })),
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't load that order.") };
  }
}

const OVERPAID = "sm:overpaid";
const CREDIT_MOVED = "sm:credit-moved";
const PAYMENT_MOVED = "sm:payment-moved";
const NOT_WAITING_CODE = "sm:not-waiting";
const NOT_WAITING =
  "That order isn't waiting for collection here. It may already have been collected.";

/**
 * Hand the order over, taking the money if any is still owed.
 *
 * Claims awaiting/ready → collected CONDITIONALLY, so two staff scanning the
 * same order at once hand it over once. Only then are the holds committed —
 * doing it the other way round could take stock for an order somebody else had
 * already collected.
 */
export async function markCollected(
  orderId: string,
  /** What the customer handed over at the counter. Empty for an order already
   *  paid online, which is most of them. */
  tenders: PosTender[] = [],
  /** The cashier's attestation that an unprepared order is actually packed. */
  opts: { acknowledgeUnprepared?: boolean } = {},
): Promise<{
  success?: boolean;
  error?: string;
  changeDue?: number;
  /** The order was never marked ready and needs an explicit confirmation. The
   *  counter turns this into a dialog rather than a dead error. */
  needsPreparedAck?: boolean;
  /** A DEPOSIT was recorded and the parcel stayed on the shelf (Step 18). Its
   *  presence is how the counter knows not to say "handed over". */
  partial?: { paid: number; remaining: number };
}> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid order." };

  // ── What does this order still owe? ──────────────────────────────────────
  // Read BEFORE the claim. A tender that doesn't cover the total has to be
  // refused while the goods are still on the shelf: claiming first and then
  // refusing the payment is the one outcome with no recovery, because the order
  // reads as collected and the money was never taken.
  let owed:
    | {
        total: unknown;
        payment_method: string | null;
        payment_status: string | null;
        pickup_status: string | null;
        customer_id: string | null;
      }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({
          total: orders.total,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          pickup_status: orders.pickupStatus,
          // ★ A BALANCE BELONGS TO SOMEBODY, and that somebody is whoever the
          // ORDER is for. markCollected takes no customer id, deliberately —
          // accepting one would let a counter spend a stranger's credit.
          customer_id: orders.customerId,
        })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            eq(orders.pickupLocationId, op.locationId),
            or(
              eq(orders.pickupStatus, "awaiting"),
              eq(orders.pickupStatus, "ready"),
            ),
          ),
        )
        .limit(1),
    );
    owed = rows[0];
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't read the order.") };
  }
  if (!owed) return { error: NOT_WAITING };

  // ── Was this order ever prepared? ────────────────────────────────────────
  // BEFORE the tenders, for the reason the money read is before the claim: a
  // refusal has to land while the goods are still on the shelf and nothing has
  // been taken. See `handoverGate` for why an unprepared collection is confirmed
  // rather than forbidden — a customer who arrives before the shop has packed is
  // ordinary, and a cashier alone at the counter must still be able to serve
  // them.
  const gate = handoverGate({
    status: owed.pickup_status,
    acknowledged: opts.acknowledgeUnprepared === true,
  });
  if (!gate.allowed) {
    // `needsPreparedAck` is what turns the refusal into a dialog rather than a
    // dead error — the counter asks the one thing only the operator can answer.
    return { error: gate.reason, needsPreparedAck: true };
  }

  // Net of any deposit already left at this counter (Step 18) — otherwise a
  // customer coming back to settle would be charged the full amount twice.
  const alreadyPaid = (await paidSoFarFor([orderId])).get(orderId) ?? 0;
  const due = amountDueAtCollection({
    paymentMethod: owed.payment_method,
    paymentStatus: owed.payment_status,
    total: owed.total as number | string | null,
    paidSoFar: alreadyPaid,
  });

  let shiftId: string | null = null;
  let change = 0;
  let creditAsked = 0;
  if (due > 0) {
    const bad = validateTenderShape(
      tenders,
      `Take the ₹${due.toLocaleString("en-IN")} owed on this order before handing it over.`,
      // ★ STILL narrower than the sell counter: no store-credit spend is wired
      // here, so accepting one would mark a collection paid against a balance
      // nothing deducted. `razorpay` REJOINED it once the verify below existed.
      COUNTER_TENDER_METHODS,
    );
    if (bad) return { error: bad };
    // ── Gateway tenders (§18 Step 12) ──────────────────────────────────────
    // ★★ THE SAME CHECK THE SELL COUNTER RUNS, from the same module. Until this
    // existed, `razorpay` was kept out of COUNTER_TENDER_METHODS entirely,
    // because accepting it here would have marked a collection paid against
    // money nobody had confirmed was taken.
    //
    // ★ BEFORE THE CLAIM, for the reason the money read and the prepared gate
    // are: a refusal has to land while the goods are still on the shelf. After
    // the claim the order reads as collected and the customer is walking away.
    const badGateway = await verifyGatewayTenders(op.storeId, tenders);
    if (badGateway) return { error: badGateway };

    // ── Store credit (§29) ─────────────────────────────────────────────────
    // ★ A BALANCE BELONGS TO SOMEBODY. A walk-in cannot have one, and this
    // counter has no way to attach a customer — the order already names one or
    // it does not — so a credit tender on an anonymous order is refused rather
    // than silently ignored.
    creditAsked = accountTenderTotal(tenders, "store_credit");
    if (creditAsked > 0) {
      if (!owed.customer_id) {
        return {
          error:
            "This order has no customer account to draw store credit from.",
        };
      }
      // A PRE-check, purely so the cashier gets a message with the real balance
      // in it. The GUARANTEE is the conditional UPDATE inside the claim below,
      // which re-proves the balance at the moment it moves — the same split
      // placePosSale makes.
      const balance = await getCreditBalance(op.storeId, owed.customer_id);
      if (balance + 0.0001 < creditAsked) {
        return {
          error: `That customer has ₹${balance.toLocaleString("en-IN")} in store credit, which doesn't cover ₹${creditAsked.toLocaleString("en-IN")}.`,
        };
      }
    }

    // Resolve drawer policy for EVERY payment path, including a deposit. A
    // short tender still puts physical money in the till and must obey the same
    // open-shift requirement as a sale that settles in full.
    shiftId = await currentShiftIdFor(op.locationId);
    if (!shiftId) {
      let requireShift = false;
      try {
        requireShift =
          (await getStoreSettings())["pos.requireOpenShift"] === true;
      } catch {
        // A settings read failure must not refuse a customer standing at the
        // counter — the same posture getCurrentShift takes.
        requireShift = false;
      }
      if (requireShift) {
        return {
          error: "Open a shift before taking payment at the counter.",
        };
      }
    }

    // ── Part payment (roadmap Step 18) ─────────────────────────────────────
    // ★★ A DEPOSIT DOES NOT HAND THE PARCEL OVER. `markCollected` claims
    // awaiting|ready → collected in ONE statement, and a part-paid collection
    // is neither state — so rather than invent a third, a short payment is
    // RECORDED and the claim is skipped entirely. The shop holds a deposit and
    // the goods; the customer collects when they settle. Owner's decision,
    // 2026-08-18.
    //
    // ★ NO STORE CREDIT ON A DEPOSIT, deliberately. The credit spend's
    // exactly-once guarantee comes from running inside the claim's transaction
    // (§29); with no claim there is nothing to make it exactly-once, and a
    // double-tap would deduct a balance twice. Money instruments only.
    const paid = tenders.reduce((sum, t) => sum + (t.amount || 0), 0);
    const isPartial = paid > 0 && !coversTotal(paid, due);
    if (isPartial) {
      if (creditAsked > 0) {
        return {
          error:
            "Store credit can only settle a collection in full. Take the rest another way, or pay the balance with credit at the end.",
        };
      }
      // The drawer is resolved HERE too — a deposit is money in the till
      // exactly as a full payment is, and must join the same shift.
      return takeDeposit({
        op,
        orderId,
        tenders,
        paid,
        shiftId,
      });
    }

    // ★ ONLY THE FULL PATH REACHES THIS. `settleTenders` refuses a short
    // payment by design, and a deposit IS a short payment — so the partial
    // branch above returns before it, rather than this being taught a second
    // meaning.
    const settled = settleTenders(tenders, due);
    if ("error" in settled) return { error: settled.error };
    change = settled.change;
  } else if (Array.isArray(tenders) && tenders.length > 0) {
    // Refused, not ignored. Recording tenders against an order that owes
    // nothing would inflate the drawer's expected cash with money that was
    // never handed over, reporting it SHORT — the very failure being fixed,
    // pointed the other way.
    return { error: "This order is already paid — no payment is due here." };
  }

  let claimed:
    | {
        id: string;
        order_ref: string | null;
        customer_id: string | null;
        location_name: string | null;
        location_address: Record<string, unknown> | null;
      }
    | undefined;
  try {
    // ★★ THE CLAIM, CREDIT SPEND, AND TENDER INSERT ARE ONE TRANSACTION.
    // Nothing may report success unless the money audit row committed too.
    const rows = await withService(async (db) => {
      if (due > 0) {
        // Deposits take this same row lock. Re-check the balance after gateway
        // verification so a concurrent counter payment cannot make this claim
        // over-collect against the stale amount shown in the UI.
        const lockedRows = await db
          .select({
            total: orders.total,
            payment_method: orders.paymentMethod,
            payment_status: orders.paymentStatus,
          })
          .from(orders)
          .where(
            and(
              eq(orders.id, orderId),
              eq(orders.storeId, op.storeId),
              eq(orders.fulfilmentType, "pickup"),
              eq(orders.pickupLocationId, op.locationId),
              or(
                eq(orders.pickupStatus, "awaiting"),
                eq(orders.pickupStatus, "ready"),
              ),
            ),
          )
          .limit(1)
          .for("update");
        const locked = lockedRows[0];
        if (!locked) throw new Error(NOT_WAITING_CODE);

        const paidRows = await db
          .select({
            paid: sql<string>`coalesce(sum(${orderPayments.amount}), 0)`,
          })
          .from(orderPayments)
          .where(eq(orderPayments.orderId, orderId));
        const dueNow = amountDueAtCollection({
          paymentMethod: locked.payment_method,
          paymentStatus: locked.payment_status,
          total: locked.total,
          paidSoFar: Number(paidRows[0]?.paid) || 0,
        });
        if (Math.abs(dueNow - due) > 0.0001) {
          throw new Error(PAYMENT_MOVED);
        }
      }

      const claimedRows = await db
        .update(orders)
        .set({
          pickupStatus: "collected",
          collectedAt: sql`now()`,
          collectedBy: op.staffId ?? op.name,
          status: "completed",
          // ★ THE AUDIT TRAIL. `pickup_ready_at` is the date promised at
          // checkout and is already non-null on every new pickup, so it cannot
          // double as evidence of actual preparation. When the cashier confirms
          // an awaiting order is physically packed, stamp the dedicated actual
          // time in the SAME statement as collected_at. Equality therefore
          // answers "collected without a prior Mark ready" exactly, without
          // destroying the customer promise.
          ...(gate.unprepared ? { pickupPreparedAt: sql`now()` } : {}),
          // "Pay at store" means the money changes hands at the counter — so
          // handing the order over IS the payment. Only that method is
          // settled here: an order already paid online must not be touched,
          // and one that failed must not be marked paid by a hand-over.
          paymentStatus: sql`case when ${orders.paymentMethod} = 'pay_at_store'
                                  and ${orders.paymentStatus} = 'pending'
                             then 'paid' else ${orders.paymentStatus} end`,
          // ONLY when money was taken here. An order paid online weeks ago that
          // happens to be collected during this shift never touched this
          // drawer, and stamping it would pull its whole total into the
          // Z-report's gross as takings the till never took.
          ...(due > 0 && shiftId ? { shiftId } : {}),
          // ★ CREDIT IS A PAYMENT, NOT A DISCOUNT (§29). `total` stays the full
          // goods value; this records how much of it a balance settled.
          //
          // ★★ IT ACCUMULATES. Checkout may ALREADY have applied credit to this
          // order, so an assignment would erase that and understate what the
          // balance has paid for — which is what a later credit note reverses.
          ...(creditAsked > 0
            ? {
                storeCreditUsed: sql`coalesce(${orders.storeCreditUsed}, 0) + ${creditAsked}`,
              }
            : {}),
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            // The operator's own shop — never a location from the client.
            eq(orders.pickupLocationId, op.locationId),
            or(
              eq(orders.pickupStatus, "awaiting"),
              eq(orders.pickupStatus, "ready"),
            ),
          ),
        )
        .returning({
          id: orders.id,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          ...pickupShopColumns,
        });

      // Nothing was claimed — a second tap, or someone else got there first.
      // Returning empty leaves both the balance and tender ledger untouched.
      if (!claimedRows.length) return claimedRows;

      if (creditAsked > 0) {
        const spent = await spendCredit(
          {
            storeId: op.storeId,
            customerId: claimedRows[0].customer_id ?? "",
            amount: creditAsked,
            orderId,
            note: "Collection",
          },
          db,
        );
        // Throwing rolls the claim back with the failed balance movement.
        if (!spent) throw new Error(CREDIT_MOVED);
      }

      if (due > 0) {
        await db.insert(orderPayments).values(
          tenders.map((t) => ({
            orderId,
            storeId: op.storeId,
            shiftId,
            method: t.method,
            amount: t.amount,
            tendered: t.method === "cash" ? (t.tendered ?? t.amount) : null,
            // netCashFromSales groups by order and takes max(change), so this
            // remains replicated only on cash rows and is subtracted once.
            changeDue: t.method === "cash" ? change : null,
            reference: t.reference?.slice(0, 120) ?? null,
          })),
        );
      }
      return claimedRows;
    });
    claimed = rows[0];
  } catch (err) {
    if (err instanceof Error && err.message === CREDIT_MOVED) {
      return {
        error:
          "That customer's store credit changed while you were paying. Check the balance and take it again.",
      };
    }
    if (err instanceof Error && err.message === PAYMENT_MOVED) {
      return {
        error:
          "This order's payment changed while you were taking it. Reload and check the remaining balance.",
      };
    }
    if (err instanceof Error && err.message === NOT_WAITING_CODE) {
      return { error: NOT_WAITING };
    }
    if (
      isUniqueViolation(err) &&
      tenders.some((t) => t.method === "razorpay")
    ) {
      return {
        error: "That online payment has already been used on another sale.",
      };
    }
    return { error: dbErrorMessage(err, "Couldn't complete the collection.") };
  }

  if (!claimed) return { error: NOT_WAITING };

  // Turn every hold for this order into a real sale. commitHold is idempotent,
  // so a retry after a partial failure cannot double-decrement.
  try {
    const holds = await withService((db) =>
      db
        .select({ id: stockReservations.id })
        .from(stockReservations)
        .where(
          and(
            eq(stockReservations.ownerType, "pickup"),
            eq(stockReservations.ownerId, orderId),
            eq(stockReservations.status, "held"),
          ),
        ),
    );
    for (const h of holds) await commitHold(h.id, orderId);
  } catch (err) {
    // The customer has the goods — the collection is NOT undone. A stranded
    // hold is visible in the reservations table and swept later; refusing here
    // would leave the shop unable to record a hand-over that happened.
    console.error("markCollected (holds):", err);
  }

  emitEvent({
    type: "order.collected",
    storeId: op.storeId,
    locationId: op.locationId,
    actor: { type: "admin", id: op.staffId ?? null, label: op.name },
    subject: { type: "order", id: orderId, label: claimed.order_ref ?? "" },
    customerId: claimed.customer_id,
    // Declared on this event too — an empty "Where" row on a thank-you is the
    // same defect as an empty address on the ready notice.
    payload: { pickupLocation: claimed.location_name ?? "" },
  });

  revalidatePath("/pos/pickups");
  return { success: true, changeDue: change };
}

/** Tell the shopper it's packed and waiting. */
export async function markReadyForPickup(
  orderId: string,
): Promise<{ success?: boolean; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  // Every current POS role has this named capability, cashier included: in
  // most shops the person on the till is also the person packing the order.
  // Keep the capability check distinct from `sell` so a future restricted role
  // can take payment without being allowed to send a ready notification.
  if (!posCan(op.role, "fulfil_pickup")) {
    return {
      error: "You are not allowed to mark a collection order ready.",
    };
  }

  try {
    const rows = await withService((db) =>
      db
        .update(orders)
        .set({
          pickupStatus: "ready",
          // Actual physical preparation, separate from pickup_ready_at (the
          // checkout promise). The hand-over path preserves this earlier value.
          pickupPreparedAt: sql`now()`,
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            eq(orders.pickupLocationId, op.locationId),
            eq(orders.pickupStatus, "awaiting"),
          ),
        )
        .returning({
          id: orders.id,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          pickup_code: orders.pickupCode,
          ...pickupShopColumns,
        }),
    );
    const row = rows[0];
    if (!row) return { error: "That order isn't waiting here." };

    emitEvent({
      type: "order.ready_for_pickup",
      storeId: op.storeId,
      locationId: op.locationId,
      actor: { type: "admin", id: op.staffId ?? null, label: op.name },
      subject: { type: "order", id: orderId, label: row.order_ref ?? "" },
      customerId: row.customer_id,
      // ★ WITHOUT THESE THE EMAIL IS USELESS. "Ready to collect" that doesn't
      // say WHERE is the one message in the pickup flow whose entire job is an
      // address — and the template declares both tokens, so an emitter that
      // doesn't supply them doesn't produce a shorter email, it produces
      // "Pickup location" and "Pickup address" as empty labelled rows.
      payload: {
        pickupLocation: row.location_name ?? "",
        pickupAddress: formatAddressLine(row.location_address),
        // ★ WITHOUT THIS the email says "ready" and gives them nothing to
        // present. The code is text so it renders in every client; the QR is
        // on the collection page the CTA links to.
        collectionCode: row.pickup_code
          ? formatCollectionCode(row.pickup_code)
          : "",
      },
    });
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't update the order.") };
  }

  revalidatePath("/pos/pickups");
  return { success: true };
}

/**
 * Find a collection by the code the customer is holding up (roadmap Step 3).
 *
 * ★ THE CODE IS A LOOKUP KEY, NOT AN AUTHORISATION. The operator is already
 * authenticated and device-bound; this only saves them typing an order
 * reference. Scoped to the STORE, and the result says which shop it belongs to
 * rather than pretending it doesn't exist — a customer standing at Andheri with
 * an order waiting at Bandra needs to be told that, not "not found".
 */
export async function findPickupByCode(
  rawCode: string,
): Promise<{ order?: PickupOrder; otherLocation?: string; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  const code = normalizeCollectionCode(rawCode);
  // Cheap shape check first, so a scanner pointed at a milk carton never
  // becomes a database lookup.
  if (!isCollectionCode(code)) {
    return { error: "That doesn't look like a collection code." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          order_ref: orders.orderRef,
          shipping_address: orders.shippingAddress,
          total: orders.total,
          created_at: orders.createdAt,
          expires_at: orders.pickupExpiresAt,
          status: orders.pickupStatus,
          pickup_location_id: orders.pickupLocationId,
          // What is still owed depends on both of these — see below.
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          location_name: sql<string | null>`(
            select l.name from ${storeLocations} l
             where l.id = ${orders.pickupLocationId}
          )`,
        })
        .from(orders)
        .where(and(eq(orders.storeId, op.storeId), eq(orders.pickupCode, code)))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return { error: "No collection found for that code." };

    // Belongs to another shop in the same store — say which, so the customer
    // can be sent to the right place.
    if (row.pickup_location_id !== op.locationId) {
      return { otherLocation: row.location_name ?? "another shop" };
    }

    const addr = (row.shipping_address ?? {}) as Record<string, unknown>;
    const name =
      [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() || null;

    // ★ THE REAL FIGURES, NOT ZEROES. Both of these were hardcoded to 0 on the
    // reasoning that a scan "lands on the order itself, where the caller re-reads
    // what it needs" — but nothing re-reads: the scanned order is rendered by the
    // SAME row component as the queue. So a pay-at-store collection scanned at
    // the counter drew "Hand over" instead of "Take payment" and skipped the
    // tender pad, and every scanned order read "0 items".
    //
    // No money could be lost — markCollected re-reads what is owed server-side
    // and refuses a hand-over that doesn't cover it (validateTenderShape) — but
    // the button described the wrong action, so the cashier tapped expecting to
    // hand goods over and got an error about money instead.
    const itemRows = await withService((db) =>
      db
        .select({ n: count() })
        .from(orderItems)
        .where(eq(orderItems.orderId, row.id)),
    ).catch(() => []);

    const scannedPaid = (await paidSoFarFor([row.id])).get(row.id) ?? 0;
    return {
      order: {
        id: row.id,
        orderRef: row.order_ref ?? "",
        customerName: name,
        itemCount: Number(itemRows[0]?.n) || 0,
        total: Number(row.total) || 0,
        placedAt: row.created_at,
        expiresAt: row.expires_at,
        // NOT defaulted to "awaiting": that would present an expired or
        // already-collected order as live, which is the whole bug being fixed.
        // collectionState() reads an unknown status as "gone" (no button).
        status: row.status ?? "",
        amountDue: amountDueAtCollection({
          paymentMethod: row.payment_method,
          paymentStatus: row.payment_status,
          total: row.total,
          paidSoFar: scannedPaid,
        }),
        paidSoFar: scannedPaid,
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't look that code up.") };
  }
}

/**
 * How much store credit the customer on this collection can spend (§29).
 *
 * ★ FETCHED WHEN THE TENDER PAD OPENS, not carried on the queue row. The queue
 * is POLLED every 30s and its whole design is one cheap indexed read (§22); a
 * balance lookup per row would put a query on that hot path for a figure almost
 * no collection uses. One read, on demand, for the one order being settled.
 *
 * ★ DISPLAY AND A CAP, NEVER THE AUTHORITY. `markCollected` re-reads the
 * balance and spends it through a conditional UPDATE inside its claim, so a
 * figure that goes stale between here and there costs a clear refusal, not an
 * overdraw — the same split the sell counter makes.
 *
 * Fails to 0, which simply hides the option: a blip must not stop a cashier
 * taking payment by some other means.
 */
export async function getCollectionCredit(orderId: string): Promise<number> {
  const op = await resolvePosOperator();
  if (!op || !posCan(op.role, "sell")) return 0;
  if (typeof orderId !== "string" || !orderId) return 0;
  try {
    const rows = await withService((db) =>
      db
        .select({ customer_id: orders.customerId })
        .from(orders)
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            // The operator's own shop — never a location from the client.
            eq(orders.pickupLocationId, op.locationId),
          ),
        )
        .limit(1),
    );
    const customerId = rows[0]?.customer_id;
    if (!customerId) return 0;
    return await getCreditBalance(op.storeId, customerId);
  } catch (err) {
    console.error("getCollectionCredit:", err);
    return 0;
  }
}
