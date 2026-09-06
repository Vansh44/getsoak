import "server-only";

// Where returned goods physically land (roadmap Step 13).
//
// ── The bug this exists to close ───────────────────────────────────────────
// `order_returns.location_id` was never populated by return-actions.ts, so
// `receiveReturn` fell through to the bare `adjust_stock` wrapper — which per
// CODEBASE §22 delegates to the store's DEFAULT location. A parcel that
// arrived in Mumbai credited Delhi, both shops wrong by the same quantity,
// with nothing anywhere to flag it. The till path never had this problem: it
// restocks `adjust_stock_at(op.locationId)`, the operator's own shop.
//
// ── Why `receive_stock` and not `returns` ──────────────────────────────────
// ★ The obvious filter is the `returns` capability, and it is the wrong one.
// `returns` means "a customer may hand goods back AT THIS COUNTER" — it
// `requires: ["pos"]`, because someone has to be standing there. A postal
// return has no counter: the parcel goes to whichever address the merchant
// prints on the label, typically the warehouse. Filtering on `returns` would
// make the warehouse unselectable for exactly the returns that actually arrive
// there, which is the commoner case for an online store.
//
// So CANDIDATES are locations that can have stock booked in at all
// (`receive_stock`, which defaults true for every location type and carries no
// plan gate), and the returns DESK is used only to pick the default.
//
// ── One list, two jobs ─────────────────────────────────────────────────────
// ★ The picker and the server-side validation read the SAME function. A
// separate "is this allowed" query is how the two drift until the dropdown
// offers something the action refuses — the rule §23 states for
// `locationCan` and §22 for `RegisterConfig.canDiscount`.

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storeLocations, stores } from "@/drizzle/schema";
import {
  isLocationType,
  locationCan,
  normalizeCapabilities,
} from "@/lib/locations/capabilities";
import { effectivePlan } from "@/lib/plans";
import { getViewerLocations, scopeAllows } from "@/lib/locations/scope";
import { logError } from "@/lib/observability/logger";

export interface RestockLocation {
  id: string;
  name: string;
  /** Has the `returns` capability — a counter customers hand goods back at.
   *  Used ONLY to choose the default; it never decides who is listed. */
  acceptsReturns: boolean;
}

/**
 * Which shelves this viewer may book returned goods onto.
 *
 * Empty is a legitimate answer (a single-location store, a store whose one
 * location cannot receive stock) and the caller must treat it as "carry on as
 * before" rather than as an error — see `receiveReturn`.
 */
export async function listRestockLocations(
  storeId: string,
): Promise<RestockLocation[]> {
  try {
    // ★ SCOPED. A branch manager must not be able to book goods onto another
    // branch's shelf — the same escape the orders exporter had (§23).
    const scope = await getViewerLocations();

    const [locRows, storeRow] = await withService(async (db) => {
      const locRows = await db
        .select({
          id: storeLocations.id,
          name: storeLocations.name,
          type: storeLocations.type,
          capabilities: storeLocations.capabilities,
        })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.storeId, storeId),
            eq(storeLocations.active, true),
          ),
        )
        .orderBy(storeLocations.name);

      const storeRow = await db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);

      return [locRows, storeRow] as const;
    });

    // Read by ID, not by host: this runs behind `getActingStoreId()`, which a
    // platform operator can point at a store that is not the request's host.
    const plan = effectivePlan(storeRow[0] ?? {});

    const out: RestockLocation[] = [];
    for (const l of locRows) {
      if (!scopeAllows(scope, l.id)) continue;
      const caps = normalizeCapabilities(
        l.capabilities,
        isLocationType(l.type) ? l.type : "shop",
      );
      if (!locationCan(caps, "receive_stock", { plan })) continue;
      out.push({
        id: l.id,
        name: l.name,
        acceptsReturns: locationCan(caps, "returns", { plan }),
      });
    }
    return out;
  } catch (err) {
    // ★ FAILS TO EMPTY, WHICH IS TODAY'S BEHAVIOUR. A blip must not stop a
    // merchant booking a return in; it costs the location, which the next
    // stock count surfaces. An unbookable return does not.
    logError("returns: listRestockLocations", err, { storeId });
    return [];
  }
}

/**
 * Which one to preselect — PURE, so the picker and the action cannot disagree
 * about what "obvious" means.
 *
 * ★ ONE RETURNS DESK WINS OVER ONE CANDIDATE. A store with a warehouse and a
 * shop has two places goods can be booked in, and only one of them is where
 * customers hand things back; preferring it is right far more often than not,
 * and the merchant can still pick the warehouse for a posted parcel.
 *
 * ★ NULL MEANS ASK, and the caller must honour that rather than reaching for
 * the first entry. Silently picking one is precisely the defect this step
 * closes — it would just be a nicer-looking implementation of the same bug.
 */
export function defaultRestockLocation(
  locations: RestockLocation[],
): string | null {
  const desks = locations.filter((l) => l.acceptsReturns);
  if (desks.length === 1) return desks[0]!.id;
  if (locations.length === 1) return locations[0]!.id;
  return null;
}
