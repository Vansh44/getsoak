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
  | "manual";

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
