// ---------------------------------------------------------------------------
// Loading the offers that could apply to one cart — server-only.
//
// ★ SERVER-ONLY, DELIBERATELY. This imports the db client, which pulls in `pg`
// and therefore `fs`, so a client component importing it FAILS THE BUILD while
// typecheck passes happily. That is why the vocabulary lives in
// `lib/offers/types.ts` (client-safe) and the arithmetic in
// `lib/offers/apply.ts` (pure) — the same three-way split
// `lib/logs/failure-types.ts` and `lib/themes/meta.ts` make.
//
// The engine is arithmetic; this is the authorisation boundary around it. Every
// query carries the trusted `store_id`, and nothing about an offer comes from
// the client except a code string.
// ---------------------------------------------------------------------------

import "server-only";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  offerLocations,
  offerProducts,
  offerRedemptions,
  offerUserGroups,
  offers,
  stores,
  userGroupMembers,
} from "@/drizzle/schema";
import { getStoreSettings } from "@/lib/settings/resolve";
import { decodeReward, normalizeOnSalePriceMode } from "./types";
import type { Offer, OfferChannel } from "./types";
import { MAX_EVALUATED_OFFERS } from "./apply";
import type { OfferContext } from "./apply";
import { effectivePlan, limitsFor } from "@/lib/plans";

/** How many offer rows we are ever willing to consider for one cart. Read a
 *  little wider than the engine's own cap so the engine, not the query, is what
 *  decides which ones win — but still bounded, because a merchant with 500
 *  active offers must not turn one checkout into a 500-row join. */
const OFFER_FETCH_LIMIT = MAX_EVALUATED_OFFERS * 3;

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Every offer that is worth handing to the engine for this store.
 *
 * Deliberately does NOT pre-filter on channel, dates, code or trigger: the
 * engine reports WHY each offer did not apply, and the near-miss nudge needs
 * the offers the cart just failed to qualify for. Filtering them out here would
 * make the engine's `skipped` list — the thing that answers "why did this
 * customer not get that offer?" at a counter — silently incomplete.
 */
export async function loadLiveOffers(
  db: Db,
  storeId: string,
  customerId: string | null,
): Promise<Offer[]> {
  const rows = await db
    .select({
      id: offers.id,
      name: offers.name,
      status: offers.status,
      delivery: offers.delivery,
      code: offers.code,
      priority: offers.priority,
      createdAt: offers.createdAt,
      validFrom: offers.validFrom,
      validUntil: offers.validUntil,
      channels: offers.channels,
      triggerType: offers.triggerType,
      triggerConfig: offers.triggerConfig,
      rewardType: offers.rewardType,
      rewardConfig: offers.rewardConfig,
      maxRedemptions: offers.maxRedemptions,
      maxPerCustomer: offers.maxPerCustomer,
      budgetPaise: offers.budgetPaise,
      redemptionCount: offers.redemptionCount,
      spentPaise: offers.spentPaise,
    })
    .from(offers)
    .where(and(eq(offers.storeId, storeId), eq(offers.status, "active")))
    .orderBy(desc(offers.priority), asc(offers.createdAt), asc(offers.id))
    .limit(OFFER_FETCH_LIMIT);

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  // Scoping and per-customer usage in three bounded queries rather than one
  // per offer — a cart must not cost N round trips at ~46ms each.
  const [scopeRows, locationRows, groupRows, usedRows] = await Promise.all([
    db
      .select({
        offerId: offerProducts.offerId,
        productId: offerProducts.productId,
        variantId: offerProducts.variantId,
        categoryId: offerProducts.categoryId,
      })
      .from(offerProducts)
      .where(
        and(
          eq(offerProducts.storeId, storeId),
          inArray(offerProducts.offerId, ids),
        ),
      ),
    db
      .select({
        offerId: offerLocations.offerId,
        locationId: offerLocations.locationId,
      })
      .from(offerLocations)
      .where(
        and(
          eq(offerLocations.storeId, storeId),
          inArray(offerLocations.offerId, ids),
        ),
      ),
    db
      .select({
        offerId: offerUserGroups.offerId,
        groupId: offerUserGroups.groupId,
      })
      .from(offerUserGroups)
      .where(
        and(
          eq(offerUserGroups.storeId, storeId),
          inArray(offerUserGroups.offerId, ids),
        ),
      ),
    // Per-customer usage. `reserve_offer_use` re-checks this atomically at
    // charge time — this read is only so the engine can decline early and the
    // storefront never advertises an offer the shopper has already used up.
    customerId
      ? db
          .select({ offerId: offerRedemptions.offerId })
          .from(offerRedemptions)
          .where(
            and(
              eq(offerRedemptions.storeId, storeId),
              eq(offerRedemptions.customerId, customerId),
              inArray(offerRedemptions.offerId, ids),
            ),
          )
      : Promise.resolve([] as { offerId: string }[]),
  ]);

  const scopeBy = new Map<
    string,
    { productIds: string[]; variantIds: string[]; categoryIds: string[] }
  >();
  for (const r of scopeRows) {
    const e = scopeBy.get(r.offerId) ?? {
      productIds: [],
      variantIds: [],
      categoryIds: [],
    };
    if (r.productId) e.productIds.push(r.productId);
    if (r.variantId) e.variantIds.push(r.variantId);
    if (r.categoryId) e.categoryIds.push(r.categoryId);
    scopeBy.set(r.offerId, e);
  }

  const locBy = new Map<string, string[]>();
  for (const r of locationRows) {
    locBy.set(r.offerId, [...(locBy.get(r.offerId) ?? []), r.locationId]);
  }
  const grpBy = new Map<string, string[]>();
  for (const r of groupRows) {
    grpBy.set(r.offerId, [...(grpBy.get(r.offerId) ?? []), r.groupId]);
  }
  const usedBy = new Map<string, number>();
  for (const r of usedRows) {
    usedBy.set(r.offerId, (usedBy.get(r.offerId) ?? 0) + 1);
  }

  return rows.map((r) => {
    const trigger = (r.triggerConfig ?? {}) as Record<string, unknown>;
    const reward = (r.rewardConfig ?? {}) as Record<string, unknown>;
    const scope = scopeBy.get(r.id);

    const globalHit =
      r.maxRedemptions !== null && r.redemptionCount >= r.maxRedemptions;
    const perCustomerHit =
      r.maxPerCustomer !== null &&
      customerId !== null &&
      (usedBy.get(r.id) ?? 0) >= r.maxPerCustomer;

    return {
      id: r.id,
      name: r.name,
      status: r.status === "active" ? "active" : "disabled",
      delivery:
        r.delivery === "code" || r.delivery === "link"
          ? r.delivery
          : "automatic",
      code: r.code,
      priority: r.priority,
      createdAt: r.createdAt,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      channels: (r.channels ?? []) as OfferChannel[],
      locationIds: locBy.get(r.id) ?? [],
      groupIds: grpBy.get(r.id) ?? [],
      trigger: {
        type: r.triggerType === "min_subtotal" ? "min_subtotal" : "always",
        minSubtotal: num(trigger.minSubtotal),
      },
      reward: decodeReward(r.rewardType, reward),
      productIds: scope?.productIds ?? [],
      variantIds: scope?.variantIds ?? [],
      categoryIds: scope?.categoryIds ?? [],
      exhausted: globalHit || perCustomerHit,
      // ★ REMAINING BUDGET, NOT A YES/NO. An offer with ₹40 left must give ₹40
      // and no more; treating the cap as a flag lets the last order overshoot
      // it by the whole reward. `null` stays uncapped.
      remainingBudget:
        r.budgetPaise === null
          ? null
          : Math.max(0, (r.budgetPaise - (r.spentPaise ?? 0)) / 100),
    } satisfies Offer;
  });
}

/** The customer groups a shopper belongs to, for group-restricted offers. */
export async function loadCustomerGroupIds(
  db: Db,
  customerId: string | null,
): Promise<string[]> {
  if (!customerId) return [];
  const rows = await db
    .select({ groupId: userGroupMembers.groupId })
    .from(userGroupMembers)
    .where(eq(userGroupMembers.userId, customerId));
  return rows.map((r) => r.groupId).filter((g): g is string => Boolean(g));
}

/**
 * The store-level half of `OfferContext`, resolved from settings.
 *
 * ★ THE ENGINE IS TOLD THE ANSWER, NEVER THE POLICY. It receives resolved
 * values (`onSalePrice`, `maxTotalDiscountPercent`, `autoApply`) rather than
 * reading settings itself, which is what keeps it pure and what stops a second
 * consumer resolving the same setting differently.
 */
export async function loadOfferPolicy(): Promise<
  Pick<OfferContext, "onSalePrice" | "maxTotalDiscountPercent" | "autoApply">
> {
  const settings = await getStoreSettings();
  const ceiling = settings["offers.maxTotalDiscountPercent"];
  return {
    onSalePrice: normalizeOnSalePriceMode(settings["offers.onSalePrice"]),
    // ★ `typeof === "number"`, never `Number(x) || 50`. The registry declares
    // min 0, and a real 0 means "no offer may discount anything" — the
    // merchant who locked it down hardest would otherwise silently get 50%.
    // Exactly the `pos.maxDiscountPercent` trap.
    maxTotalDiscountPercent: typeof ceiling === "number" ? ceiling : 50,
    autoApply: settings["offers.autoApply"] === true,
  };
}

/**
 * How many active offers this store has and may have. DISPLAY ONLY —
 * `assertCanActivateOffer` is the gate, because it takes the same per-store
 * advisory lock and counts inside the writing transaction. A number read here
 * and acted on later is a read-then-write window.
 */
export async function offerCapacity(
  storeId: string,
): Promise<{ limit: number | null; active: number }> {
  return withService(async (db) => {
    const [store] = await db
      .select({ plan: stores.plan, planExpiresAt: stores.planExpiresAt })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const [row] = await db
      .select({ n: count() })
      .from(offers)
      .where(and(eq(offers.storeId, storeId), eq(offers.status, "active")));
    // effectivePlan, never the stored one: an expired timed grant IS free
    // today, and the gate reads it that way (CODEBASE.md §15).
    const limits = limitsFor(store ? effectivePlan(store) : "free");
    return { limit: limits.maxActiveOffers, active: row?.n ?? 0 };
  });
}
