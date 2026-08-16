import "server-only";
import { and, count, eq, or } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { orders } from "@/drizzle/schema";
import { logWarn } from "@/lib/observability/logger";

/**
 * How many collections are waiting on this location's shelf — the badge on the
 * register's Orders rail entry.
 *
 * ★ A COUNT, NOT `getPickupQueue().orders.length`. The badge is drawn by
 * app/pos/layout.tsx, so it runs on EVERY POS page load — including /pos/sell,
 * whose whole design goal is a register that opens and scans without waiting on
 * the network (docs/pos-plan.md §10). The queue read is two queries and returns
 * up to 100 rows with their line-item counts; this is one indexed COUNT.
 *
 * ⚠ THE PREDICATE MUST MIRROR `getPickupQueue`'s (pos-pickup-actions.ts): same
 * store, same location, `fulfilment_type = 'pickup'`, and awaiting-or-ready
 * only — collected and expired orders leave the queue, because it is a list of
 * work rather than a history. A badge that disagrees with the list under it is
 * worse than no badge: it sends someone to a screen to look for work that isn't
 * there, and they stop trusting the number. Pinned by pickup-count.test.ts.
 *
 * ★ IT IS NOT A `"use server"` FILE. Every export of one of those is a publicly
 * reachable endpoint, and this takes a store and a location as arguments — the
 * exact shape that must never be callable with someone else's ids. Callers
 * derive both from `resolvePosOperator()`, never from client input. Same rule
 * as lib/retention/prune.ts and lib/domains/reconcile.ts.
 */
export async function countPickupsWaiting(
  storeId: string,
  locationId: string,
): Promise<number> {
  try {
    return await readPickupsWaiting(storeId, locationId);
  } catch (err) {
    // ★ FAIL TO ZERO — never throw into the layout. This decorates a rail entry
    // that is present either way; a DB blip must cost the merchant a badge, not
    // the ability to serve a customer. The screen itself surfaces the error.
    // String(err), not the error object: JSON.stringify serialises an Error to
    // `{}`, so the structured field would carry nothing at all.
    logWarn("pos pickup badge count failed", {
      storeId,
      locationId,
      error: String(err),
    });
    return 0;
  }
}

/**
 * The same count with failure preserved for live polling.
 *
 * The server-rendered layout intentionally degrades a failed decorative badge
 * to zero. A live poll cannot do that: zero means "the work disappeared" and
 * would overwrite a trustworthy last-known count. The Route Handler uses this
 * strict form and translates a rejection to 503.
 */
export async function readPickupsWaiting(
  storeId: string,
  locationId: string,
): Promise<number> {
  const rows = await withService((db) =>
    db
      .select({ n: count() })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          eq(orders.fulfilmentType, "pickup"),
          eq(orders.pickupLocationId, locationId),
          or(
            eq(orders.pickupStatus, "awaiting"),
            eq(orders.pickupStatus, "ready"),
          ),
        ),
      ),
  );
  return Number(rows[0]?.n) || 0;
}
