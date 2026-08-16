import "server-only";

// What cancelling an order DOES to stock — extracted so there is exactly one
// implementation of it (roadmap Step 2).
//
// ── Why this module exists ─────────────────────────────────────────────────
// It lived inline in `updateOrderStatus`, which was fine while the dashboard
// was the only thing that could cancel. Customer-initiated cancellation makes
// that two callers, and a second hand-written copy of "claim the reservation,
// release at the right location, release pickup holds" is a bug waiting to
// happen: the failure mode is silent (stock simply never comes back) and it
// only shows up in a stock count weeks later.
//
// ── The two paths are NOT interchangeable ──────────────────────────────────
//   • A RESERVED order took units off the shelf at checkout → release them,
//     exactly once, AT THE LOCATION THAT RESERVED THEM.
//   • A PICKUP order only HELD its units — they never left the shelf — so it
//     releases holds instead. Restocking one would ADD units that never moved,
//     inflating that shop's count on every cancellation. This is why such
//     orders carry `stock_status: 'none'` and the claim below matches nothing
//     for them (CODEBASE §23, Phase F).
//
// ── Authority is the CALLER's job ──────────────────────────────────────────
// Nothing here checks who you are. `runner` decides the DB scope, so the
// dashboard keeps its RLS-scoped `withUser(admin)` claim while the customer
// path — where a shopper has SELECT but not UPDATE on their own order — passes
// `withService` AFTER proving ownership itself. Convention #12's model.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { withService } from "@/lib/db/client";
import { orderItems, orders, stockReservations } from "@/drizzle/schema";
import { releaseHold } from "@/lib/inventory/reservations";
import { reinstateCreditForOrder } from "@/lib/credit/store-credit";
import { logError } from "@/lib/observability/logger";

/** A DB scope to run the claim in — `withService`, or `(fn) => withUser(id, fn)`. */
export type DbRunner = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

/**
 * Give back everything a cancelled order was holding.
 *
 * Best-effort by design: the status change is the source of truth and must
 * never be blocked by a cleanup write. `options.restock: false` suppresses
 * only the physical stock return; store-credit reinstatement and pickup-hold
 * release still run because they are money/reservations, not restocking.
 *
 * Idempotent. Every cleanup path uses a conditional claim or ledger key, so
 * calling it twice releases nothing the second time.
 */
export async function releaseCancelledOrder(
  storeId: string,
  orderId: string,
  runner: DbRunner,
  reason = "order_cancelled",
  options: { restock?: boolean } = {},
): Promise<void> {
  // ── Reserved stock ───────────────────────────────────────────────────────
  // Claim the release by flipping stock_status 'reserved' → 'released' in ONE
  // conditional UPDATE, then act only if this call won:
  //   • legacy / never-reserved orders sit at 'none'   → no phantom restock
  //   • an already-cancelled order is 'released'       → no double restock
  //   • two concurrent cancels                         → one UPDATE wins
  const claimed =
    options.restock === false
      ? []
      : await runner((db) =>
          db
            .update(orders)
            .set({ stockStatus: "released" })
            .where(
              and(
                eq(orders.id, orderId),
                eq(orders.storeId, storeId),
                eq(orders.stockStatus, "reserved"),
              ),
            )
            // location_id rides along with the claim: a POS sale reserved at
            // the register's own location (reserve_stock_at), so the units must
            // go BACK there. The plain release_stock wrapper delegates to the
            // store's DEFAULT location, which would move stock between shops
            // silently — the selling location never recovering its unit and
            // the default gaining one it never had, compounding per cancel.
            .returning({ id: orders.id, location_id: orders.locationId }),
        ).catch((err) => {
          logError("cancel: stock release claim", err, { orderId });
          return [] as { id: string; location_id: string | null }[];
        });

  if (claimed.length > 0) {
    // The claim already proved this order belongs to `storeId`.
    const items = await runner((db) =>
      db
        .select({
          product_id: orderItems.productId,
          variant_id: orderItems.variantId,
          quantity: orderItems.quantity,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId)),
    ).catch(
      () =>
        [] as {
          product_id: string | null;
          variant_id: string | null;
          quantity: number;
        }[],
    );

    const locationId = claimed[0]?.location_id ?? null;

    for (const item of items) {
      // The Postgres function does the atomic restock + ledger row.
      await withService((db) =>
        db.execute(
          locationId
            ? sql`select release_stock_at(p_store => ${storeId}, p_location => ${locationId}, p_product => ${item.product_id}, p_variant => ${item.variant_id}, p_qty => ${item.quantity}, p_order => ${orderId}, p_reason => ${reason})`
            : sql`select release_stock(p_store => ${storeId}, p_product => ${item.product_id}, p_variant => ${item.variant_id}, p_qty => ${item.quantity}, p_order => ${orderId}, p_reason => ${reason})`,
        ),
      ).catch((err) => logError("cancel: release_stock", err, { orderId }));
    }
  }

  // ── Store credit ─────────────────────────────────────────────────────────
  // ★ An order paid (wholly or partly) with credit gives it back when the
  // order is cancelled — otherwise cancelling silently destroys the
  // customer's money. Keyed on the order, so a second cancel reinstates
  // nothing rather than minting it.
  await reinstateCreditForOrder(storeId, orderId);

  // ── Pickup holds ─────────────────────────────────────────────────────────
  // Never restocked (see the header): the units are still physically on the
  // shelf. Releasing is idempotent, so a second cancel is a no-op.
  try {
    const holds = await withService((db) =>
      db
        .select({ id: stockReservations.id })
        .from(stockReservations)
        .where(
          and(
            eq(stockReservations.storeId, storeId),
            eq(stockReservations.ownerType, "pickup"),
            eq(stockReservations.ownerId, orderId),
            eq(stockReservations.status, "held"),
          ),
        ),
    );
    for (const h of holds) await releaseHold(h.id);
  } catch (err) {
    // Never block a cancellation over a hold. The TTL sweep is the backstop.
    logError("cancel: release pickup holds", err, { orderId });
  }
}
