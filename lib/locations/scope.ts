import "server-only";

// Location scope — the SECOND tenancy dimension (roadmap Phase B2).
//
// `store_id` answers "whose data is this". This answers "which of their shops
// may this person see". Both must be derived from the viewer server-side and
// never accepted from the client (roadmap invariant 7): a filter you can pass
// in is not a permission boundary, it is a suggestion.
//
// ── The contract ────────────────────────────────────────────────────────────
//   null  = UNRESTRICTED — sees every location (owner, superadmin, platform
//           operator, or an admin nobody has assigned anywhere)
//   [...] = restricted to exactly these location ids
//
// null-means-all matches PLAN_LIMITS (null = unlimited) and pos_layouts (no row
// = show everything). It also means this migration changes nothing until a
// merchant deliberately assigns someone — absence is not restriction.
//
// ⚠ An empty ARRAY is not the same as null. It means "assigned to nothing that
// still exists" and must show NOTHING, or deleting a location would silently
// promote a restricted admin to seeing the whole store.

import { and, eq, inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { adminLocations, storeLocations } from "@/drizzle/schema";
import { getViewerContext } from "@/app/dashboard/lib/access";

export type LocationScope = string[] | null;

/**
 * Which locations the current dashboard viewer may see, or null for all.
 *
 * Superadmins and platform operators are unrestricted by definition — the
 * owner sees everything (the settled decision in docs/locations-ia.md §6).
 */
export async function getViewerLocations(): Promise<LocationScope> {
  const ctx = await getViewerContext();

  // Follows the access.ts rule: a DB error must never be turned into an access
  // decision. Unrestricted is the SAFE direction here — it preserves today's
  // behaviour rather than blanking a working dashboard.
  if (!ctx || ctx.dbError) return null;
  if (ctx.isSuperadmin) return null;

  if (ctx.isPlatformAdmin) return null;
  // No profile row means the access lookup found nothing to restrict against.
  if (!ctx.profile) return null;

  try {
    const rows = await withService((db) =>
      db
        .select({ location_id: adminLocations.locationId })
        .from(adminLocations)
        // Join through store_locations so a location deleted from under the
        // binding stops counting, rather than filtering orders against an id
        // nothing can match.
        .innerJoin(
          storeLocations,
          eq(storeLocations.id, adminLocations.locationId),
        )
        .where(
          and(
            eq(adminLocations.adminId, ctx.userId),
            eq(adminLocations.storeId, ctx.storeId),
          ),
        ),
    );
    // No bindings at all = unrestricted. See the header: absence is not
    // restriction, or this would blank every existing admin's dashboard.
    if (rows.length === 0) return null;
    return rows.map((r) => r.location_id);
  } catch {
    return null;
  }
}

/**
 * Is `locationId` inside the scope?
 *
 * A null location (an online order placed before fulfilment routing exists, or
 * any non-POS order) is visible to everyone: it belongs to no shop, so
 * withholding it from location-bound staff would hide the store's entire
 * online order book from them.
 */
export function scopeAllows(
  scope: LocationScope,
  locationId: string | null | undefined,
): boolean {
  if (scope === null) return true;
  if (!locationId) return true;
  return scope.includes(locationId);
}

/**
 * The viewer's scope with NAMES, for the topbar tag.
 *
 * ★ A SEPARATE READ FROM `getViewerLocations`, deliberately. That one answers a
 * SECURITY question and is called on every scoped query, so it stays a bare id
 * list — joining names onto it would make every order page pay for a label only
 * the header uses.
 *
 * Returns [] for an unrestricted viewer, which is what the tag renders as
 * nothing: an owner does not need telling they can see their own store.
 */
export async function getViewerLocationNames(): Promise<
  { id: string; name: string }[]
> {
  const scope = await getViewerLocations();
  if (scope === null) return [];
  // An EMPTY scope is "assigned to nothing that still exists" — a real state
  // (their shop was deleted) and NOT unrestricted. There are no names to show,
  // but the caller must not read the empty array as "sees everything"; that
  // distinction lives in getViewerLocations, which returns [] not null.
  if (scope.length === 0) return [];

  try {
    return await withService((db) =>
      db
        .select({ id: storeLocations.id, name: storeLocations.name })
        .from(storeLocations)
        .where(inArray(storeLocations.id, scope))
        .orderBy(storeLocations.name),
    );
  } catch {
    // The tag is an explanation, not a gate — losing it costs a label, and the
    // scope itself is enforced elsewhere regardless.
    return [];
  }
}
