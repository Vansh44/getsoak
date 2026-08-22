import "server-only";

// Stock reservations — holding units without selling them (roadmap Phase E,
// supabase/locations_04_reservations.sql).
//
//   available = on_hand - reserved
//
//   hold     reserved += qty     the goods are still on the shelf, but spoken for
//   commit   on_hand -= qty      the sale happened
//   release  reserved -= qty     it didn't
//
// This is ADDITIVE. `reserve_stock_at` still decrements on_hand outright, so
// COD checkout and the POS register are untouched. What changed is that both
// stock guards now subtract `reserved`, so a hold genuinely protects units
// rather than being decorative.
//
// Every function here is a thin wrapper over an atomic RPC — roadmap invariant
// 1: no stock change ever happens with an UPDATE from application code.

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";

/** What a hold is FOR. Text rather than an enum so a new owner needs no
 *  migration — the channels/registry philosophy (roadmap §1.4). */
export type ReservationOwner =
  | "pickup"
  | "payment_pending"
  | "channel"
  | "manual"
  /** An exchange's replacement, held from the moment it's requested so the
   *  size they swapped for can't sell out while the parcel is in transit. */
  | "exchange";

export interface HoldRequest {
  storeId: string;
  locationId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  owner: ReservationOwner;
  ownerId?: string | null;
  /** Minutes until it lapses. Omit for a hold something else will end. */
  ttlMinutes?: number | null;
}

/**
 * Put units aside. Returns the reservation id, or null when the location
 * hasn't got that many AVAILABLE (on_hand minus what is already held).
 *
 * Null is an answer, not an error — the caller decides whether to try another
 * location or tell the shopper.
 */
export async function holdStock(req: HoldRequest): Promise<string | null> {
  if (!Number.isInteger(req.quantity) || req.quantity <= 0) return null;
  try {
    const res = await withService((db) =>
      db.execute(
        sql`select hold_stock_at(p_store => ${req.storeId}, p_location => ${req.locationId}, p_product => ${req.productId}, p_variant => ${req.variantId ?? null}, p_qty => ${req.quantity}, p_owner_type => ${req.owner}, p_owner_id => ${req.ownerId ?? null}, p_ttl_minutes => ${req.ttlMinutes ?? null}) as id`,
      ),
    );
    return (res.rows[0] as { id?: string | null } | undefined)?.id ?? null;
  } catch (err) {
    console.error("holdStock:", err);
    return null;
  }
}

/**
 * The sale happened: turn the hold into a real decrement plus a ledger row.
 *
 * The RPC claims the held→committed transition conditionally, so a retried
 * webhook or a double tap moves stock exactly once. False means it was already
 * settled — treat that as success in an idempotent caller.
 */
export async function commitHold(
  reservationId: string,
  orderId?: string | null,
): Promise<boolean> {
  try {
    const res = await withService((db) =>
      db.execute(
        sql`select commit_stock_hold(p_reservation => ${reservationId}, p_order => ${orderId ?? null}) as ok`,
      ),
    );
    return (res.rows[0] as { ok?: boolean } | undefined)?.ok === true;
  } catch (err) {
    console.error("commitHold:", err);
    return false;
  }
}

/** It didn't happen: give the units back. No ledger row — nothing moved. */
export async function releaseHold(reservationId: string): Promise<boolean> {
  try {
    const res = await withService((db) =>
      db.execute(
        sql`select release_stock_hold(p_reservation => ${reservationId}, p_status => ${"released"}) as ok`,
      ),
    );
    return (res.rows[0] as { ok?: boolean } | undefined)?.ok === true;
  } catch (err) {
    console.error("releaseHold:", err);
    return false;
  }
}

/**
 * Free holds that have lapsed. A hold nobody completes must not lock stock
 * forever — without this, an abandoned pickup would make units unsellable
 * indefinitely, which is worse than never having held them.
 *
 * Returns how many were freed. Safe to call repeatedly; the RPC only ever
 * claims rows still in `held`.
 */
export async function sweepExpiredHolds(limit = 500): Promise<number> {
  try {
    const res = await withService((db) =>
      db.execute(sql`select sweep_expired_holds(p_limit => ${limit}) as n`),
    );
    return Number((res.rows[0] as { n?: number } | undefined)?.n) || 0;
  } catch (err) {
    console.error("sweepExpiredHolds:", err);
    return 0;
  }
}

export interface AvailabilityLine {
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface ShortLine extends AvailabilityLine {
  /** What the location can actually serve right now. */
  available: number;
}

/**
 * Which of these lines the location cannot serve, READ-ONLY.
 *
 * ★★ THIS IS NOT A GUARANTEE AND MUST NOT BE USED AS ONE. It is a read, so the
 * answer is stale the instant it returns; `reserve_stock_at` and `hold_stock_at`
 * remain the only things that can promise stock, because each is a single
 * conditional UPDATE.
 *
 * What it is FOR is telling somebody BEFORE an irreversible step. The counter
 * gateway payment is the case: without it a cashier takes ₹500, and only then
 * discovers the shelf is empty — leaving captured money against a sale that
 * cannot complete. Refusing beforehand costs nothing.
 *
 * ⚠ `available` counts held units as gone (on_hand − reserved), which is the
 * same arithmetic the RPCs use, so this cannot report a line as servable that
 * a hold would then refuse.
 */
export async function shortLinesAt(
  storeId: string,
  locationId: string,
  lines: AvailabilityLine[],
): Promise<ShortLine[]> {
  const wanted = lines.filter(
    (l) => Number.isInteger(l.quantity) && l.quantity > 0 && l.productId,
  );
  if (wanted.length === 0) return [];
  // Same product twice in one cart is one demand on one shelf.
  const demand = new Map<string, AvailabilityLine & { quantity: number }>();
  for (const line of wanted) {
    const key = `${line.productId}:${line.variantId ?? ""}`;
    const seen = demand.get(key);
    if (seen) seen.quantity += line.quantity;
    else demand.set(key, { ...line });
  }

  try {
    const requested = [...demand.values()].map(
      (line) =>
        sql`(${line.productId}::uuid, ${line.variantId}::uuid, ${line.quantity}::integer)`,
    );
    const rows = await withService((db) =>
      db.execute(
        sql`with wanted(product_id, variant_id, quantity) as (
              values ${sql.join(requested, sql`, `)}
            )
            select wanted.product_id,
                   wanted.variant_id,
                   coalesce(level.on_hand - level.reserved, 0) as available,
                   case when wanted.variant_id is null
                        then product.track_inventory
                        else variant.track_inventory end as track_inventory,
                   case when wanted.variant_id is null
                        then product.allow_backorder
                        else variant.allow_backorder end as allow_backorder
              from wanted
              left join products as product
                on product.id = wanted.product_id
               and product.store_id = ${storeId}
              left join product_variants as variant
                on variant.id = wanted.variant_id
               and variant.product_id = wanted.product_id
               and variant.store_id = ${storeId}
              left join inventory_levels as level
                on level.store_id = ${storeId}
               and level.location_id = ${locationId}
               and level.product_id = wanted.product_id
               and level.variant_id is not distinct from wanted.variant_id`,
      ),
    );
    const have = new Map<
      string,
      { available: number; tracked: boolean; backorder: boolean }
    >();
    for (const r of rows.rows as {
      product_id: string;
      variant_id: string | null;
      available: number | string;
      track_inventory?: boolean | null;
      allow_backorder?: boolean | null;
    }[]) {
      have.set(`${r.product_id}:${r.variant_id ?? ""}`, {
        available: Number(r.available) || 0,
        // Undefined keeps older test doubles compatible; the real query
        // always returns boolean/null.
        tracked:
          r.track_inventory === undefined ? true : r.track_inventory === true,
        backorder: r.allow_backorder === true,
      });
    }
    const short: ShortLine[] = [];
    for (const [key, l] of demand) {
      const stock = have.get(key);
      // Mirror reserve_stock_at exactly: untracked and backorderable lines do
      // not block gateway capture even when their level is absent or negative.
      if (!stock || !stock.tracked || stock.backorder) continue;
      if (stock.available < l.quantity) {
        short.push({ ...l, available: stock.available });
      }
    }
    return short;
  } catch (err) {
    // ★ FAILS TO "NOTHING IS SHORT". This is a courtesy check in front of a
    // real guarantee; refusing a sale because a read blipped would be strictly
    // worse than letting the authoritative reserve decide.
    console.error("shortLinesAt:", err);
    return [];
  }
}
