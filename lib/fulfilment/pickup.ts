import "server-only";

// Pick up in store (roadmap Phase F, supabase/locations_05_pickup.sql).
//
// Three rules the spec is right to insist on, all enforced here rather than in
// the UI:
//
//   1. Pickup is offered ONLY at locations that carry the capability — which
//      itself requires `pos`, because someone has to hand the goods over.
//   2. A shop with no stock is not offered. Driving to a shop to be told it
//      isn't there is worse than not seeing the option.
//   3. The customer's chosen location OVERRIDES fulfilment routing entirely.
//      They are driving to a specific shop; no strategy gets to second-guess
//      that.
//
// Stock is HELD, not sold (Phase E): the goods sit on that shop's shelf until
// someone hands them over. This is the first real consumer of reservations.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
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
import { effectivePlan } from "@/lib/plans";
import { getStoreSettings } from "@/lib/settings/resolve";
import { getCurrentStore } from "@/lib/store/resolve";
import { releaseHold } from "@/lib/inventory/reservations";
import { recordEvent } from "@/lib/notifications/record";
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

export async function pickupHoldDays(): Promise<number> {
  try {
    const n = Number((await getStoreSettings())["fulfilment.pickupHoldDays"]);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 5;
  } catch {
    return 5;
  }
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

    recordEvent({
      type: "order.pickup_expired",
      storeId: order.store_id,
      locationId: order.pickup_location_id,
      actor: { type: "system" },
      subject: { type: "order", id: order.id, label: order.order_ref ?? "" },
      customerId: order.customer_id,
    });
  }

  return claimed.length;
}
