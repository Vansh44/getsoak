import { asc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storeLocations, userGroups } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { listOffers, getOfferCapacity } from "@/app/actions/offer-actions";
import { getStoreSettingsForEditor } from "@/app/actions/store-settings";
import { OffersView } from "./offers-view";

/**
 * Offers (docs/offers-plan.md).
 *
 * ★ THE PERMISSION SECTION IS `promotions`, though everything the merchant sees
 * says "Offers". Roles store the key, so renaming it would revoke the grant on
 * every saved role — the `navigation` precedent. That key previously pointed at
 * `/dashboard/promotions`, which had no route at all: every merchant granted
 * the section saw a sidebar link that 404'd.
 */
export default async function OffersPage() {
  // ★ Returns the viewer's access rather than a boolean — it REDIRECTS when
  // the section is denied, so reaching the next line already proves `view`.
  // `can(...,"manage")` is then the separate question of whether the controls
  // render, and the actions re-check it regardless: a hidden button is not a
  // permission.
  const access = await requireSectionAccess("promotions", "view");
  const canManage = access.can("promotions", "manage");
  const storeId = await getActingStoreId();

  const [{ offers, error }, capacity, settings, locations] = await Promise.all([
    listOffers(),
    getOfferCapacity(),
    // The offers group carries the policy every offer is priced under — the
    // per-order ceiling especially, since best-offer-wins makes it the brake.
    // Rendered through the SHARED settings card (convention #9), not a second
    // editor of its own.
    getStoreSettingsForEditor("Offers").catch(() => ({
      plan: "free",
      settings: [],
    })),
    withService((db) =>
      db
        .select({ id: storeLocations.id, name: storeLocations.name })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId))
        .orderBy(asc(storeLocations.name)),
    ).catch(() => []),
  ]);

  return (
    <OffersView
      offers={offers}
      loadError={error}
      limit={capacity.limit}
      activeCount={capacity.active}
      plan={settings.plan}
      settings={settings.settings}
      locationCount={locations.length}
      canManage={canManage}
    />
  );
}

/** Shared by the new/edit pages so the form's pickers cannot drift from here. */
export async function loadOfferScopes(storeId: string) {
  const [locations, groups] = await Promise.all([
    withService((db) =>
      db
        .select({ id: storeLocations.id, name: storeLocations.name })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId))
        .orderBy(asc(storeLocations.name)),
    ).catch(() => [] as { id: string; name: string }[]),
    withService((db) =>
      db
        .select({ id: userGroups.id, name: userGroups.name })
        .from(userGroups)
        .where(eq(userGroups.storeId, storeId))
        .orderBy(asc(userGroups.name)),
    ).catch(() => [] as { id: string; name: string }[]),
  ]);
  return { locations, groups };
}
