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
import { and, asc, count, desc, eq, inArray, not } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  offerLocations,
  offerProducts,
  offerRedemptions,
  offerUserGroups,
  inventoryLevels,
  offers,
  orders,
  stores,
  userGroupMembers,
} from "@/drizzle/schema";
import { getStoreSettings } from "@/lib/settings/resolve";
import { getCurrentStore } from "@/lib/store/resolve";
import {
  decodeConditions,
  decodeReward,
  decodeTrigger,
  normalizeOnSalePriceMode,
} from "./types";
import type { Offer, OfferChannel } from "./types";
import { MAX_EVALUATED_OFFERS } from "./apply";
import type { OfferContext } from "./apply";
import { effectivePlan, limitsFor } from "@/lib/plans";

/** How many offer rows we are ever willing to consider for one cart. Read a
 *  little wider than the engine's own cap so the engine, not the query, is what
 *  decides which ones win — but still bounded, because a merchant with 500
 *  active offers must not turn one checkout into a 500-row join. */
const OFFER_FETCH_LIMIT = MAX_EVALUATED_OFFERS * 3;

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
      conditions: offers.conditions,
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

  // ★★ ONE QUERY FOR EVERY GIFT, not one per offer. A cart must not cost N
  // round trips at ~46ms each — the same rule the scope and usage reads follow.
  // Resolved BEFORE the map so the engine can withdraw a gift it cannot
  // deliver rather than promising it and failing at reserve time (plan §12).
  const giftStock = await resolveGiftAvailability(db, storeId, rows);

  return rows.map((r) => {
    const reward = (r.rewardConfig ?? {}) as Record<string, unknown>;
    const decoded = decodeConditions(r.conditions);
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
      // ★ THROUGH THE SHARED DECODER, never a ternary. The hand-written
      // version here collapsed Phase B's `contains_product`/`contains_category`
      // to `always`, so a contents-gated offer applied to every cart — see
      // `decodeTrigger`.
      trigger: decodeTrigger(r.triggerType, r.triggerConfig),
      conditions: decoded.conditions,
      // ★ Resolved below against `on_hand − reserved`, the same figure a paid
      // line is checked against. `undefined` when this offer gives no gift.
      giftAvailable: giftStock.get(r.id),
      // ★ An unreadable condition REFUSES the offer rather than running it
      // without the restriction — see `Offer.conditionsUnreadable`.
      conditionsUnreadable: decoded.dropped,
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
/**
 * Has this customer ordered here before? `null` when we cannot know.
 *
 * ★★ `null` FOR A GUEST, AND THE ENGINE TREATS IT AS NOT-FIRST. A guest
 * checkout has no history to check, so answering `true` would hand every guest
 * the new-customer discount on every order forever — which is the entire abuse
 * this condition exists to prevent. Returning `null` rather than `false` keeps
 * "nobody to check" distinguishable from "checked, and they have ordered", so a
 * future surface can explain the difference instead of implying a decision.
 *
 * ★★ A CANCELLED ORDER STILL COUNTS, WITH ONE EXCEPTION. Ignoring cancelled
 * orders looks kinder and opens the obvious farm: order, cancel, order again
 * with the discount, indefinitely. But counting ALL of them punishes the
 * customer whose FIRST attempt was auto-cancelled by the pending-payment reaper
 * — they never received anything and would lose the new-customer offer through
 * our own timeout. So a cancellation whose payment FAILED does not count, and
 * every other order does. That closes both holes rather than trading one for
 * the other.
 *
 * ★ FAILS CLOSED. An unreadable history returns `false`, not `null` and not
 * `true`: refusing a discount is recoverable, and granting one on an unknown
 * history is how a blip becomes a discount for every returning customer at
 * once.
 */
export async function loadFirstOrderState(
  db: Db,
  storeId: string,
  customerId: string | null,
): Promise<boolean | null> {
  if (!customerId) return null;
  try {
    // EXISTS with a limit, not a COUNT: the question is "any?", and a customer
    // with 400 orders must not cost a full scan on every cart price.
    const [prior] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          eq(orders.customerId, customerId),
          not(
            and(
              eq(orders.status, "cancelled"),
              eq(orders.paymentStatus, "failed"),
            )!,
          ),
        ),
      )
      .limit(1);
    return prior === undefined;
  } catch {
    return false;
  }
}

/**
 * Which gift offers still have stock to give.
 *
 * ★ AVAILABLE, NOT ON HAND. `on_hand − reserved` is what a paid line is
 * checked against, and a gift promised to somebody else's pending order is
 * exactly as unavailable as one that has been sold.
 *
 * ★ ACROSS EVERY LOCATION, deliberately. Which shelf serves an online order is
 * a routing OUTCOME decided later (§23), so requiring stock at one specific
 * location here would withdraw a gift the store can actually fulfil. The
 * reservation at order time is the authoritative check; this is the
 * don't-advertise-what-you-haven't-got filter in front of it.
 *
 * ★ FAILS OPEN. An unreadable stock table returns an empty map, so
 * `giftAvailable` is `undefined` and the engine treats the gift as unchecked
 * rather than unavailable — a blip must not cancel every gift offer in the
 * store. The reservation still refuses at order time.
 */
async function resolveGiftAvailability(
  db: Db,
  storeId: string,
  rows: readonly { id: string; rewardType: string; rewardConfig: unknown }[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const wanted = rows
    .filter((r) => r.rewardType === "free_item")
    .map((r) => ({
      id: r.id,
      reward: decodeReward(r.rewardType, r.rewardConfig),
    }))
    .filter((r) => !!r.reward.giftProductId);
  if (wanted.length === 0) return out;

  try {
    const productIds = [
      ...new Set(wanted.map((w) => w.reward.giftProductId as string)),
    ];
    const levels = await db
      .select({
        productId: inventoryLevels.productId,
        variantId: inventoryLevels.variantId,
        onHand: inventoryLevels.onHand,
        reserved: inventoryLevels.reserved,
      })
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.storeId, storeId),
          inArray(inventoryLevels.productId, productIds),
        ),
      );

    const availableBy = new Map<string, number>();
    for (const l of levels) {
      const key = `${l.productId}:${l.variantId ?? ""}`;
      const free = Number(l.onHand ?? 0) - Number(l.reserved ?? 0);
      availableBy.set(key, (availableBy.get(key) ?? 0) + free);
    }

    for (const w of wanted) {
      const key = `${w.reward.giftProductId}:${w.reward.giftVariantId ?? ""}`;
      const need = Math.max(1, Math.trunc(w.reward.giftQuantity ?? 1));
      out.set(w.id, (availableBy.get(key) ?? 0) >= need);
    }
  } catch {
    return new Map();
  }
  return out;
}

export async function loadOfferPolicy(): Promise<
  Pick<
    OfferContext,
    "onSalePrice" | "maxTotalDiscountPercent" | "autoApply" | "timeZone"
  >
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
    // ★ THE SAME ZONE ANALYTICS USES, from the same place, so "Monday" means
    // one thing across the product. A store that has never set one gets the
    // India-first default rather than the container's UTC — which would put
    // every Indian happy hour 5½ hours early.
    timeZone: await loadStoreTimeZone(),
  };
}

/**
 * The store's IANA timezone, for a `time_window` condition.
 *
 * ★ VALIDATED, NOT TRUSTED. `settings.business.timeZone` is merchant-entered
 * and anon-readable, and `Intl` throws on an unknown zone — inside the pure
 * engine that would turn one bad settings value into a crashed cart. An
 * unparseable value falls back to the default, which is what the analytics
 * range parser already does with the same column.
 */
async function loadStoreTimeZone(): Promise<string> {
  try {
    const store = await getCurrentStore();
    const business = (store.settings as Record<string, unknown> | null)
      ?.business as Record<string, unknown> | undefined;
    const zone = business?.timeZone;
    if (typeof zone === "string" && zone.trim()) {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return zone;
    }
  } catch {
    // Unreadable store row, or an invalid stored zone. Either way the default
    // is a better answer than the server's own zone.
  }
  return DEFAULT_STORE_TIME_ZONE;
}

/**
 * ★ India-first, matching `lib/analytics/range.ts`. Not the container's zone:
 * Cloud Run runs in UTC, which would shift every Indian window by 5½ hours.
 */
export const DEFAULT_STORE_TIME_ZONE = "Asia/Kolkata";

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
      .select({
        plan: stores.plan,
        planExpiresAt: stores.planExpiresAt,
        compPlan: stores.compPlan,
        compExpiresAt: stores.compExpiresAt,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const [row] = await db
      .select({ n: count() })
      .from(offers)
      .where(and(eq(offers.storeId, storeId), eq(offers.status, "active")));
    // effectivePlan, never the stored one: an expired timed grant IS free
    // today, and the gate reads it that way (CODEBASE.md §15).
    const limits = limitsFor(
      store
        ? effectivePlan({
            plan: store.plan,
            plan_expires_at: store.planExpiresAt,
            comp_plan: store.compPlan,
            comp_expires_at: store.compExpiresAt,
          })
        : "free",
    );
    return { limit: limits.maxActiveOffers, active: row?.n ?? 0 };
  });
}
