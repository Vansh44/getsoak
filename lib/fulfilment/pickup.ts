import "server-only";

// Pick up in store (roadmap Phase F, supabase/locations_05_pickup.sql).
//
// Three rules the spec is right to insist on, all enforced here rather than in
// the UI:
//
//   1. Pickup is offered ONLY at locations that carry the capability — which
//      itself requires `pos`, because someone has to hand the goods over.
//   2. Every pickup-capable shop is LISTED; the shopper picks. Geography is
//      the shopper's business, not the merchant's — they know whether they
//      collect near home, near work, or on a route. Shops that can't cover the
//      basket are shown last and disabled rather than hidden, because "not
//      everything is in stock here" is information and a missing shop is not.
//   3. The customer's chosen location OVERRIDES fulfilment routing entirely.
//      They are driving to a specific shop; no strategy gets to second-guess
//      that.
//
// Stock is HELD, not sold (Phase E): the goods sit on that shop's shelf until
// someone hands them over. This is the first real consumer of reservations.

import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  inventoryLevels,
  orders,
  stockReservations,
  storeLocations,
} from "@/drizzle/schema";
import {
  locationCan,
  normalizeCapabilities,
  isLocationType,
} from "@/lib/locations/capabilities";
import { formatAddressLine } from "@/lib/locations/address";
import { effectivePlan } from "@/lib/plans";
import { getStoreSettings } from "@/lib/settings/resolve";
import {
  normalizePickupPayment,
  type PickupPaymentPolicy,
} from "@/lib/fulfilment/payment-policy";
import { getCurrentStore } from "@/lib/store/resolve";
import { releaseHold } from "@/lib/inventory/reservations";
import { recordEvent } from "@/lib/notifications/record";
import { refundDueForOrder } from "@/lib/payments/refund-reconcile";
import { lineKey, type OrderLineForRouting } from "./resolve";

export interface PickupLocation {
  id: string;
  name: string;
  address: Record<string, unknown> | null;
  /** False when this shop can't cover the whole basket — shown greyed, or
   *  hidden, but never silently offered. */
  hasStock: boolean;
}

/** Is pickup switched on for this store at all? */
export async function pickupEnabled(): Promise<boolean> {
  try {
    const settings = await getStoreSettings();
    return settings["fulfilment.offerPickup"] === true;
  } catch {
    return false;
  }
}

/**
 * The merchant's collection-payment policy (roadmap Step 1.2).
 *
 * Fails to `customer_choice` on a settings read error, matching `pickupEnabled`
 * beside it: a hiccup must not silently impose a stricter policy than the
 * merchant set, and it must never stop a store selling (invariant 6).
 */
export async function pickupPaymentPolicy(): Promise<PickupPaymentPolicy> {
  try {
    return normalizePickupPayment(
      (await getStoreSettings())["fulfilment.pickupPayment"],
    );
  } catch {
    return "customer_choice";
  }
}

export async function pickupHoldDays(): Promise<number> {
  try {
    const n = Number((await getStoreSettings())["fulfilment.pickupHoldDays"]);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 5;
  } catch {
    return 5;
  }
}

/** How long until a collection order is ready. 0 = same day. */
export async function pickupReadyDays(): Promise<number> {
  try {
    const n = Number((await getStoreSettings())["fulfilment.pickupReadyDays"]);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * When a collection order will be ready, as a DATE.
 *
 * "Ready in 2 days" makes the shopper count forward on a calendar to work out
 * what it means; a date doesn't. Same-day is called out separately because it
 * is the thing a shop is competing on — a shopper choosing collection over
 * delivery is usually choosing speed.
 *
 * Formatted SERVER-side against the same clock that stamps
 * `orders.pickup_ready_at`, so the date quoted at checkout is the date stored
 * on the order — no timezone drift between the two.
 */
export function readyOn(
  days: number,
  now = new Date(),
): { today: boolean; date: string; long: string } {
  if (days <= 0) {
    return { today: true, date: "", long: "Today" };
  }
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return {
    today: false,
    // "Fri, 1 Aug" — short enough for a card, unambiguous unlike "01/08".
    date: d.toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
    }),
    // Spelled out for the email, where there is room and no surrounding UI.
    long: d.toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }),
  };
}

/**
 * Shops a shopper could collect this basket from.
 *
 * Returns [] when pickup is off, the plan doesn't allow it, or no location
 * carries the capability — the checkout then simply doesn't offer the option.
 */
export async function pickupLocationsFor(
  storeId: string,
  lines: OrderLineForRouting[],
): Promise<PickupLocation[]> {
  if (!(await pickupEnabled())) return [];

  try {
    const store = await getCurrentStore();
    const plan = effectivePlan(store);
    const productIds = Array.from(new Set(lines.map((l) => l.productId)));

    const [locRows, levelRows] = await withService(async (db) => {
      const locRows = await db
        .select({
          id: storeLocations.id,
          name: storeLocations.name,
          type: storeLocations.type,
          address: storeLocations.address,
          active: storeLocations.active,
          capabilities: storeLocations.capabilities,
        })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.storeId, storeId),
            eq(storeLocations.active, true),
          ),
        );
      const levelRows = productIds.length
        ? await db
            .select({
              location_id: inventoryLevels.locationId,
              product_id: inventoryLevels.productId,
              variant_id: inventoryLevels.variantId,
              on_hand: inventoryLevels.onHand,
              reserved: inventoryLevels.reserved,
            })
            .from(inventoryLevels)
            .where(
              and(
                eq(inventoryLevels.storeId, storeId),
                inArray(inventoryLevels.productId, productIds),
              ),
            )
        : [];
      return [locRows, levelRows] as const;
    });

    // AVAILABLE, not on-hand: units already held for someone else's pickup
    // are not yours to promise (Phase E).
    const availableAt = new Map<string, Map<string, number>>();
    for (const l of levelRows) {
      const m = availableAt.get(l.location_id) ?? new Map<string, number>();
      m.set(
        lineKey(l.product_id, l.variant_id),
        Math.max(0, (Number(l.on_hand) || 0) - (Number(l.reserved) || 0)),
      );
      availableAt.set(l.location_id, m);
    }

    const out: PickupLocation[] = [];
    for (const l of locRows) {
      const caps = normalizeCapabilities(
        l.capabilities,
        isLocationType(l.type) ? l.type : "shop",
      );
      // The capability check also enforces `requires: ["pos"]` and the plan
      // gate — one function, never inlined (roadmap §1.1).
      if (!locationCan(caps, "pickup", { plan })) continue;

      const stock = availableAt.get(l.id) ?? new Map();
      const hasStock = lines.every(
        (line) =>
          !line.needsStock ||
          (stock.get(lineKey(line.productId, line.variantId)) ?? 0) >=
            line.quantity,
      );

      out.push({
        id: l.id,
        name: l.name,
        address: (l.address as Record<string, unknown> | null) ?? null,
        hasStock,
      });
    }
    return out;
  } catch {
    // Pickup is an extra way to buy. If we cannot work out where, the shopper
    // still gets delivery rather than a broken checkout.
    return [];
  }
}

/**
 * Cancel pickups nobody came for.
 *
 * Claims awaiting/ready → expired CONDITIONALLY per order, so a second run (or
 * a hand-over racing the sweep) can't cancel an order somebody just collected.
 * The holds are released AFTER the claim, for the same reason: releasing first
 * would free stock for an order still live.
 *
 * Refunds are deliberately NOT issued here — refunds land with the returns
 * phase, and quietly moving money on a schedule is not something to build
 * ahead of the machinery that records it. The order is cancelled and the stock
 * comes back; the merchant is told, and refunds by hand until then.
 */
export async function sweepExpiredPickups(limit = 200): Promise<number> {
  let claimed: Array<{
    id: string;
    store_id: string;
    order_ref: string | null;
    customer_id: string | null;
    pickup_location_id: string | null;
    total: number | null;
    payment_status: string | null;
  }> = [];

  try {
    claimed = await withService((db) =>
      db
        .update(orders)
        .set({ pickupStatus: "expired", status: "cancelled" })
        .where(
          and(
            eq(orders.fulfilmentType, "pickup"),
            inArray(orders.pickupStatus, ["awaiting", "ready"]),
            lt(orders.pickupExpiresAt, sql`now()`),
            sql`${orders.id} in (
              select id from ${orders} o
               where o.fulfilment_type = 'pickup'
                 and o.pickup_status in ('awaiting','ready')
                 and o.pickup_expires_at < now()
               order by o.pickup_expires_at
               limit ${limit}
            )`,
          ),
        )
        .returning({
          id: orders.id,
          store_id: orders.storeId,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          pickup_location_id: orders.pickupLocationId,
          // Needed to work out what the store now owes — see below.
          total: orders.total,
          payment_status: orders.paymentStatus,
        }),
    );
  } catch (err) {
    console.error("sweepExpiredPickups:", err);
    return 0;
  }

  for (const order of claimed) {
    try {
      const holds = await withService((db) =>
        db
          .select({ id: stockReservations.id })
          .from(stockReservations)
          .where(
            and(
              eq(stockReservations.ownerType, "pickup"),
              eq(stockReservations.ownerId, order.id),
              eq(stockReservations.status, "held"),
            ),
          ),
      );
      for (const h of holds) await releaseHold(h.id);
    } catch (err) {
      // The order is already cancelled. A stranded hold still lapses via its
      // own TTL sweep, so this is recoverable rather than lost stock.
      console.error("sweepExpiredPickups (holds):", order.id, err);
    }

    // ★ A CRON CANNOT PROMPT, SO IT HAS TO TELL.
    // An expired pickup that was PAID FOR leaves the store holding money for
    // goods nobody collected, and the decision (returns-exchanges-plan §2.2)
    // is that nothing pays that back on a schedule — money must never leave
    // without a human looking at it. The obligation therefore rides into the
    // notification the merchant already reads, rather than sitting invisible
    // in the database until a customer chases it.
    const refundDue = await refundDueForOrder({
      id: order.id,
      total: order.total,
      paymentStatus: order.payment_status,
    });

    recordEvent({
      type: "order.pickup_expired",
      storeId: order.store_id,
      locationId: order.pickup_location_id,
      actor: { type: "system" },
      subject: { type: "order", id: order.id, label: order.order_ref ?? "" },
      customerId: order.customer_id,
      payload: {
        orderRef: order.order_ref ?? "",
        currency: "INR",
        ...(refundDue > 0 ? { refund_due: refundDue } : {}),
      },
    });
  }

  return claimed.length;
}

/**
 * How far ahead the nudge goes out.
 *
 * MUST be at least TWICE the cron's own interval. The window and the schedule
 * are not in phase, so with a window of W and an interval of I the notice an
 * order actually gets is anywhere in (W − I, W]. At 24 hours against a daily
 * reaper that is (0, 24] — nothing slipped through unwarned, which is what the
 * old floor of "≥ the interval" guaranteed, but an order expiring ten minutes
 * after a run was warned ten minutes before it lapsed. A reminder nobody has
 * time to act on is the same as no reminder, and it still spends the one email
 * the claim on `pickup_warned_at` allows.
 *
 * At 48 hours against the same daily run, every order gets between 24 and 48
 * hours — a full day of notice in the worst case rather than the best.
 *
 * ⚠ Raise this if `expire-pending-payments` ever moves to a longer interval.
 *
 * ★ IT MOVED TO HOURLY (Step 15), and this number deliberately did NOT change.
 * The constraint relaxed rather than binding: at a daily interval an order was
 * warned somewhere in (24, 48] hours out, and hourly narrows that to (47, 48] —
 * the SAME promise, kept far more precisely. Lowering the window as well would
 * change what every existing merchant's customers receive, which a scheduling
 * fix has no business doing (invariant 1).
 *
 * ⚠ What hourly does NOT fix: a merchant on `fulfilment.pickupHoldDays` = 1
 * still sees the nudge land at roughly order time, because a 24h deadline is
 * already inside a 48h window the moment it is created. The honest fix is a
 * window that scales with the hold (min(48, hold/2)) rather than a constant —
 * a deliberate notification change, not a side effect of a cron edit.
 */
export const PICKUP_WARN_HOURS = 48;

/** Hours left, rounded the way a person would say it. */
export function hoursUntil(expiresAt: string | Date, now = new Date()): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 3_600_000)) : 0;
}

/**
 * "Your order is still waiting — collect it by Friday."
 *
 * Fires on the CROSSING, not the state (§24): the claim on `pickup_warned_at`
 * is what makes it once per order. Without it a daily heartbeat would mail the
 * same customer about the same box every run until the deadline, which is how
 * people learn to ignore a merchant's email.
 *
 * Run AFTER sweepExpiredPickups — an order the sweep just cancelled is no
 * longer awaiting collection, so it must not be nudged about collecting it.
 */
export async function sweepPickupReminders(limit = 200): Promise<number> {
  let claimed: Array<{
    id: string;
    store_id: string;
    order_ref: string | null;
    customer_id: string | null;
    pickup_location_id: string | null;
    pickup_expires_at: string | null;
    location_name: string | null;
    location_address: Record<string, unknown> | null;
  }> = [];

  try {
    claimed = await withService((db) =>
      db
        .update(orders)
        .set({ pickupWarnedAt: sql`now()` })
        .where(
          and(
            eq(orders.fulfilmentType, "pickup"),
            inArray(orders.pickupStatus, ["awaiting", "ready"]),
            isNull(orders.pickupWarnedAt),
            // Still in the future — a deadline already passed belongs to the
            // expiry sweep, not to a reminder.
            gt(orders.pickupExpiresAt, sql`now()`),
            lt(
              orders.pickupExpiresAt,
              sql`now() + make_interval(hours => ${PICKUP_WARN_HOURS})`,
            ),
            sql`${orders.id} in (
              select id from ${orders} o
               where o.fulfilment_type = 'pickup'
                 and o.pickup_status in ('awaiting','ready')
                 and o.pickup_warned_at is null
                 and o.pickup_expires_at > now()
                 and o.pickup_expires_at < now() + make_interval(hours => ${PICKUP_WARN_HOURS})
               order by o.pickup_expires_at
               limit ${limit}
            )`,
          ),
        )
        .returning({
          id: orders.id,
          store_id: orders.storeId,
          order_ref: orders.orderRef,
          customer_id: orders.customerId,
          pickup_location_id: orders.pickupLocationId,
          pickup_expires_at: orders.pickupExpiresAt,
          location_name: sql<string | null>`(
            select l.name from ${storeLocations} l
             where l.id = ${orders.pickupLocationId}
          )`,
          location_address: sql<Record<string, unknown> | null>`(
            select l.address from ${storeLocations} l
             where l.id = ${orders.pickupLocationId}
          )`,
        }),
    );
  } catch (err) {
    console.error("sweepPickupReminders:", err);
    return 0;
  }

  for (const order of claimed) {
    recordEvent({
      type: "order.pickup_expiring",
      storeId: order.store_id,
      locationId: order.pickup_location_id,
      actor: { type: "system" },
      subject: { type: "order", id: order.id, label: order.order_ref ?? "" },
      customerId: order.customer_id,
      payload: {
        // Where to go and by when — a reminder without both is just anxiety.
        pickupLocation: order.location_name ?? "",
        pickupAddress: formatAddressLine(order.location_address),
        expiresOn: order.pickup_expires_at ?? "",
        hoursLeft: order.pickup_expires_at
          ? hoursUntil(order.pickup_expires_at)
          : 0,
      },
    });
  }

  return claimed.length;
}
