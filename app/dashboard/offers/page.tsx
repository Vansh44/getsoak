import { and, asc, eq, inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  categories,
  coupons,
  products,
  storeLocations,
  stores,
  userGroups,
} from "@/drizzle/schema";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { listOffers, getOfferCapacity } from "@/app/actions/offer-actions";
import { OffersView } from "./offers-view";

/** ★ Bounded read, matching the picker's own cap. A store on the unlimited
 *  plan can hold thousands of products; scoping by CATEGORY is the answer at
 *  that size, and the picker says so. */
const PRODUCT_SCOPE_LIMIT = 200;

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

  const [{ offers, error }, capacity, autoApplyOn, locations] =
    await Promise.all([
      listOffers(),
      getOfferCapacity(),
      // ★ ONLY THE ONE SETTING THIS PAGE NEEDS. The whole Offers group used to
      // be loaded here to render a settings card below the table; that card is
      // its own page now (`offers/settings`), so all that is left is the
      // switch the "Not applying" badge depends on.
      loadOffersAutoApply(storeId),
      withService((db) =>
        db
          .select({ id: storeLocations.id, name: storeLocations.name })
          .from(storeLocations)
          .where(eq(storeLocations.storeId, storeId))
          .orderBy(asc(storeLocations.name)),
      ).catch(() => []),
    ]);

  // ★★ WHICH OFFERS CAN ACTUALLY BE EMAILED.
  //
  // Coupon email campaigns are keyed on a `coupons` ROW throughout
  // (`email_campaigns`, `lib/mink/campaign-*`); offers did not replace that, so
  // the send page reads `coupons` by id and 404s otherwise. A migrated coupon
  // shares its offer's primary key (migration 0059 inserts `SELECT c.id`) and
  // one Mink wrote has a coupons row of its own, but an offer created HERE has
  // none.
  //
  // So the action is offered for exactly the set that can be sent, rather than
  // rendered for every code offer and 404ing on half of them — §23's rule that
  // a control which always fails is worse than no control. One bounded
  // existence check over the ids already listed; a failed read simply offers
  // nothing.
  const emailableOfferIds = await withService((db) =>
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(
          eq(coupons.storeId, storeId),
          inArray(
            coupons.id,
            offers.map((o) => o.id),
          ),
        ),
      ),
  )
    .then((rows) => rows.map((r) => r.id))
    .catch(() => [] as string[]);

  return (
    <OffersView
      autoApplyOn={autoApplyOn}
      emailableOfferIds={emailableOfferIds}
      offers={offers}
      loadError={error}
      limit={capacity.limit}
      activeCount={capacity.active}
      locationCount={locations.length}
      canManage={canManage}
    />
  );
}

/**
 * The store's `offers.autoApply` switch, for the new/edit forms.
 *
 * ★ SCOPED TO THE ACTING STORE rather than the host, so it is correct for a
 * platform operator too — the pattern `app/dashboard/inventory/data.ts` uses
 * for its threshold read.
 *
 * ★ FAILS TO TRUE. An unreadable setting must not put a warning on an offer
 * that works; silence returns the form to exactly what it did before.
 */
export async function loadOffersAutoApply(storeId: string): Promise<boolean> {
  try {
    return await withService(async (db) => {
      const rows = await db
        .select({ settings: stores.settings, plan: stores.plan })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const values = resolveStoreSettings(
        rows[0]?.settings as Record<string, unknown>,
        rows[0]?.plan,
      );
      return values["offers.autoApply"] === true;
    });
  } catch {
    return true;
  }
}

/** Shared by the new/edit pages so the form's pickers cannot drift from here. */
export async function loadOfferScopes(storeId: string) {
  const [locations, groups, productRows, categoryRows] = await Promise.all([
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
    // ★ PUBLISHED products only. An offer scoped to a draft product discounts
    // something no shopper can buy, so it reads as a broken offer rather than
    // an empty one.
    withService((db) =>
      db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(
          and(eq(products.storeId, storeId), eq(products.status, "published")),
        )
        .orderBy(asc(products.name))
        .limit(PRODUCT_SCOPE_LIMIT),
    ).catch(() => [] as { id: string; name: string }[]),
    withService((db) =>
      db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.storeId, storeId))
        .orderBy(asc(categories.name)),
    ).catch(() => [] as { id: string; name: string }[]),
  ]);
  return {
    locations,
    groups,
    products: productRows,
    categories: categoryRows,
  };
}
