"use server";

// ---------------------------------------------------------------------------
// Offers — merchant CRUD. `docs/offers-plan.md`.
//
// ★ GATED ON THE `promotions` SECTION KEY, though the section is labelled
// "Offers". Roles store the KEY, so renaming it would silently revoke the
// grant on every saved role — the `navigation` precedent (CODEBASE.md §11).
//
// Storefront pricing does NOT live here. `lib/offers/cart.ts` owns that, and it
// is not a "use server" file on purpose: every export of one is a publicly
// reachable endpoint, and the offer resolver takes a store id.
//
// ★★ EVERY QUERY IN THIS FILE USES `withService`, AFTER THE APP-LAYER GATE.
// That is the `store_pages` pattern and it is forced by the schema rather than
// chosen for convenience: `offers` has its sensitive columns sealed with a
// COLUMN GRANT (budget, spend, redemption counts, and the code itself), column
// grants apply to `authenticated` — which is what a store admin is — and no RLS
// policy can re-grant a column. Reading these with `withUser` returns nothing
// for the merchant who owns them, and `.returning()` on a write fails for the
// same reason.
//
// The conditions convention #2 requires for a service scope are all met and
// none of them is optional here: `getManagerIdentity("promotions")` runs first
// and returns null for anyone without the grant, every statement carries
// `eq(offers.storeId, storeId)` from the resolved host, and the form is
// validated before any of it runs.
// ---------------------------------------------------------------------------

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { withService, type Db, type UserIdentity } from "@/lib/db/client";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import {
  offerLocations,
  offerProducts,
  offerRedemptions,
  offerUserGroups,
  offers,
} from "@/drizzle/schema";
import {
  getActingStoreId,
  getManagerIdentity,
} from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { TAGS } from "@/lib/storefront/tags";
import {
  assertCanActivateOffer,
  PlanEntitlementError,
  storeAllowsPlanFeature,
} from "@/lib/plans/entitlements";
import {
  isPercentReward,
  normalizeOfferCode,
  rewardLevel,
  validateOfferRule,
  type OfferChannel,
  type OfferDelivery,
  type OfferRewardType,
  type OfferStatus,
  type OfferTriggerType,
} from "@/lib/offers/types";

export interface OfferFormData {
  name: string;
  description: string;
  status: OfferStatus;
  delivery: OfferDelivery;
  code: string;
  priority: number;
  triggerType: OfferTriggerType;
  minSubtotal: number;
  rewardType: OfferRewardType;
  percent: number;
  amount: number;
  /** `fixed_price`: the per-unit price matching items are charged. */
  unitPrice: number;
  /** Empty = every channel. */
  channels: OfferChannel[];
  validFrom: string;
  validUntil: string;
  /** 0 = unlimited, for all three. */
  maxRedemptions: number;
  maxPerCustomer: number;
  budget: number;
  locationIds: string[];
  groupIds: string[];
  /** Which lines the offer covers. All three empty = every line. */
  productIds: string[];
  variantIds: string[];
  categoryIds: string[];
}

export interface OfferRow {
  id: string;
  name: string;
  description: string | null;
  status: OfferStatus;
  delivery: OfferDelivery;
  code: string | null;
  priority: number;
  triggerType: OfferTriggerType;
  minSubtotal: number | null;
  rewardType: OfferRewardType;
  percent: number | null;
  amount: number | null;
  unitPrice: number | null;
  channels: OfferChannel[];
  validFrom: string | null;
  validUntil: string | null;
  maxRedemptions: number | null;
  maxPerCustomer: number | null;
  /** Rupees. */
  budget: number | null;
  redemptionCount: number;
  /** Rupees actually given away. */
  spent: number;
  createdAt: string;
}

export interface ActionResult {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// --- Helpers ----------------------------------------------------------------

/** ★ `promotions`, not `offers` — see the header. */
async function getAdminIdentity(): Promise<UserIdentity | null> {
  return getManagerIdentity("promotions");
}

function toTimestamp(value: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function revalidateOffers() {
  revalidatePath("/dashboard/offers");
  // The storefront reads active offers for badges and the near-miss nudge.
  revalidateTag(TAGS.coupons, "max");
}

/**
 * A minimum code length is a PRODUCT decision and lives here, not in the
 * column.
 *
 * ★ THE COLUMN ACCEPTS 1–200 ON PURPOSE. `coupons.code` has never had any
 * length validation, so one- and two-character codes exist in production, and
 * a narrower constraint would have refused to migrate a live working code
 * (invariant 1). New offers can be held to a friendlier standard without
 * making the old ones unrepresentable.
 */
const MIN_NEW_CODE_LENGTH = 3;

function validateForm(form: OfferFormData): string | null {
  const name = form.name?.trim();
  if (!name) return "Give the offer a name.";
  if (name.length > 120) return "That name is too long.";

  if (form.delivery === "automatic") {
    if (form.code?.trim()) {
      return "An automatic offer applies without a code. Clear the code, or set it to use one.";
    }
  } else {
    const code = normalizeOfferCode(form.code ?? "");
    if (!code) return "Enter a discount code.";
    if (code.length < MIN_NEW_CODE_LENGTH) {
      return `A code needs at least ${MIN_NEW_CODE_LENGTH} characters.`;
    }
    if (code.length > 200) return "That code is too long.";
  }

  const hasScope =
    (form.productIds?.length ?? 0) +
      (form.variantIds?.length ?? 0) +
      (form.categoryIds?.length ?? 0) >
    0;

  const issues = validateOfferRule(
    {
      type: form.triggerType,
      minSubtotal:
        form.triggerType === "min_subtotal" ? form.minSubtotal : undefined,
    },
    {
      type: form.rewardType,
      percent: isPercentReward(form.rewardType)
        ? Number(form.percent)
        : undefined,
      amount:
        form.rewardType === "amount_off" ? Number(form.amount) : undefined,
      unitPrice:
        form.rewardType === "fixed_price" ? Number(form.unitPrice) : undefined,
    },
    hasScope,
  );
  if (issues.length > 0) return issues[0].message;

  // ★ A LINE-LEVEL REWARD WITHOUT A SCOPE IS "20% OFF EVERYTHING", which is a
  // real offer but almost never the one a merchant reaching for "off products"
  // meant. Refused rather than silently applied to the whole catalogue: the
  // order-level reward beside it already expresses the store-wide version.
  if (rewardLevel(form.rewardType) === "line" && !hasScope) {
    return "Choose the products or categories this offer applies to. To discount every order, use an offer that takes money off the order instead.";
  }

  const from = toTimestamp(form.validFrom);
  const until = toTimestamp(form.validUntil);
  if (from && until && new Date(from) >= new Date(until)) {
    return "The end date has to be after the start date.";
  }

  for (const [label, value] of [
    ["usage limit", form.maxRedemptions],
    ["per-customer limit", form.maxPerCustomer],
    ["budget", form.budget],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      return `Enter a valid ${label}, or 0 for no limit.`;
    }
  }

  const allowed: OfferChannel[] = ["storefront", "pos"];
  if ((form.channels ?? []).some((c) => !allowed.includes(c))) {
    return "Choose where the offer runs.";
  }
  return null;
}

function buildRow(form: OfferFormData, userId: string, creating: boolean) {
  const rupeesToPaise = (n: number) =>
    n > 0 ? Math.round(Number(n) * 100) : null;
  return {
    name: form.name.trim(),
    description: form.description?.trim() || null,
    status: form.status,
    delivery: form.delivery,
    code:
      form.delivery === "automatic"
        ? null
        : normalizeOfferCode(form.code ?? ""),
    priority: Math.max(-1000, Math.min(1000, Math.trunc(form.priority) || 0)),
    triggerType: form.triggerType,
    triggerConfig:
      form.triggerType === "min_subtotal"
        ? { minSubtotal: Number(form.minSubtotal) }
        : {},
    rewardType: form.rewardType,
    rewardConfig:
      form.rewardType === "amount_off"
        ? { amount: Number(form.amount) }
        : form.rewardType === "fixed_price"
          ? { unitPrice: Number(form.unitPrice) }
          : { percent: Number(form.percent) },
    channels: form.channels ?? [],
    validFrom: toTimestamp(form.validFrom),
    validUntil: toTimestamp(form.validUntil),
    // 0 in the form means "no limit", which is NULL in the column. ★ A zero
    // must never store as a cap of zero: that reads as "nobody may use this".
    maxRedemptions: form.maxRedemptions > 0 ? form.maxRedemptions : null,
    maxPerCustomer: form.maxPerCustomer > 0 ? form.maxPerCustomer : null,
    budgetPaise: rupeesToPaise(form.budget),
    ...(creating ? { createdBy: userId } : {}),
    updatedBy: userId,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Replace an offer's location and group links.
 *
 * ★ EVERY ID IS PROVED TO BELONG TO THIS STORE FIRST, and the whole thing is
 * ONE transaction. `syncCouponGroups` cleared the old links and then inserted
 * best-effort, so a failed insert left the coupon PUBLIC — a paid restriction
 * silently lifted (CODEBASE.md §21 records it as a release blocker). Doing the
 * delete and the insert in one transaction means a failure rolls back to the
 * previous links rather than to none.
 */
async function syncScopes(
  db: Db,
  storeId: string,
  offerId: string,
  locationIds: string[],
  groupIds: string[],
  productIds: string[] = [],
  variantIds: string[] = [],
  categoryIds: string[] = [],
): Promise<void> {
  await db
    .delete(offerProducts)
    .where(
      and(
        eq(offerProducts.offerId, offerId),
        eq(offerProducts.storeId, storeId),
      ),
    );
  await db
    .delete(offerLocations)
    .where(
      and(
        eq(offerLocations.offerId, offerId),
        eq(offerLocations.storeId, storeId),
      ),
    );
  await db
    .delete(offerUserGroups)
    .where(
      and(
        eq(offerUserGroups.offerId, offerId),
        eq(offerUserGroups.storeId, storeId),
      ),
    );

  // ★ ONE ROW PER TARGET, and the CHECK enforces exactly one of the three
  // columns per row — so a row can never mean "this product AND that
  // category", which would be ambiguous about what the offer covers.
  const scopeRows = [
    ...productIds.map((productId) => ({ offerId, storeId, productId })),
    ...variantIds.map((variantId) => ({ offerId, storeId, variantId })),
    ...categoryIds.map((categoryId) => ({ offerId, storeId, categoryId })),
  ];
  if (scopeRows.length > 0) {
    await db.insert(offerProducts).values(scopeRows);
  }

  if (locationIds.length > 0) {
    await db
      .insert(offerLocations)
      .values(
        locationIds.map((locationId) => ({ offerId, storeId, locationId })),
      );
  }
  if (groupIds.length > 0) {
    await db
      .insert(offerUserGroups)
      .values(groupIds.map((groupId) => ({ offerId, storeId, groupId })));
  }
}

// --- Reads ------------------------------------------------------------------

export async function listOffers(): Promise<{
  offers: OfferRow[];
  limit: number | null;
  activeCount: number;
  error?: string;
}> {
  const admin = await getAdminIdentity();
  if (!admin)
    return {
      offers: [],
      limit: null,
      activeCount: 0,
      error: "Not authenticated",
    };
  const storeId = await getActingStoreId();

  try {
    const rows = await withService((db) =>
      db
        .select()
        .from(offers)
        .where(eq(offers.storeId, storeId))
        .orderBy(desc(offers.priority), desc(offers.createdAt)),
    );
    const mapped = rows.map(mapRow);
    return {
      offers: mapped,
      limit: null,
      activeCount: mapped.filter((o) => o.status === "active").length,
    };
  } catch (err) {
    console.error("listOffers error:", err);
    return {
      offers: [],
      limit: null,
      activeCount: 0,
      error: dbErrorMessage(err, "Couldn't load offers."),
    };
  }
}

export async function getOffer(id: string): Promise<{
  offer?: OfferRow;
  locationIds: string[];
  groupIds: string[];
  productIds: string[];
  variantIds: string[];
  categoryIds: string[];
  error?: string;
}> {
  const admin = await getAdminIdentity();
  if (!admin)
    return {
      locationIds: [],
      groupIds: [],
      productIds: [],
      variantIds: [],
      categoryIds: [],
      error: "Not authenticated",
    };
  const storeId = await getActingStoreId();

  try {
    return await withService(async (db) => {
      const [row] = await db
        .select()
        .from(offers)
        .where(and(eq(offers.id, id), eq(offers.storeId, storeId)))
        .limit(1);
      if (!row)
        return {
          locationIds: [],
          groupIds: [],
          productIds: [],
          variantIds: [],
          categoryIds: [],
          error: "Offer not found.",
        };
      const [locs, groups, scopes] = await Promise.all([
        db
          .select({ locationId: offerLocations.locationId })
          .from(offerLocations)
          .where(
            and(
              eq(offerLocations.offerId, id),
              eq(offerLocations.storeId, storeId),
            ),
          ),
        db
          .select({ groupId: offerUserGroups.groupId })
          .from(offerUserGroups)
          .where(
            and(
              eq(offerUserGroups.offerId, id),
              eq(offerUserGroups.storeId, storeId),
            ),
          ),
        db
          .select({
            productId: offerProducts.productId,
            variantId: offerProducts.variantId,
            categoryId: offerProducts.categoryId,
          })
          .from(offerProducts)
          .where(
            and(
              eq(offerProducts.offerId, id),
              eq(offerProducts.storeId, storeId),
            ),
          ),
      ]);
      return {
        offer: mapRow(row),
        locationIds: locs.map((l) => l.locationId),
        groupIds: groups.map((g) => g.groupId),
        productIds: scopes
          .map((x) => x.productId)
          .filter((x): x is string => !!x),
        variantIds: scopes
          .map((x) => x.variantId)
          .filter((x): x is string => !!x),
        categoryIds: scopes
          .map((x) => x.categoryId)
          .filter((x): x is string => !!x),
      };
    });
  } catch (err) {
    console.error("getOffer error:", err);
    return {
      locationIds: [],
      groupIds: [],
      productIds: [],
      variantIds: [],
      categoryIds: [],
      error: dbErrorMessage(err, "Couldn't load that offer."),
    };
  }
}

/** Who redeemed what — the report `offer_redemptions` exists to make possible
 *  (plan §11). Bounded, because this is a glance and not an export. */
export async function getOfferRedemptions(
  offerId: string,
  limit = 50,
): Promise<{ rows: { orderId: string | null; amount: number; at: string }[] }> {
  const admin = await getAdminIdentity();
  if (!admin) return { rows: [] };
  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select({
          orderId: offerRedemptions.orderId,
          amountPaise: offerRedemptions.amountPaise,
          createdAt: offerRedemptions.createdAt,
        })
        .from(offerRedemptions)
        .where(
          and(
            eq(offerRedemptions.offerId, offerId),
            eq(offerRedemptions.storeId, storeId),
          ),
        )
        .orderBy(desc(offerRedemptions.createdAt))
        .limit(Math.min(Math.max(1, limit), 200)),
    );
    return {
      rows: rows.map((r) => ({
        orderId: r.orderId,
        amount: (r.amountPaise ?? 0) / 100,
        at: r.createdAt,
      })),
    };
  } catch (err) {
    console.error("getOfferRedemptions error:", err);
    return { rows: [] };
  }
}

function mapRow(row: typeof offers.$inferSelect): OfferRow {
  const trigger = (row.triggerConfig ?? {}) as Record<string, unknown>;
  const reward = (row.rewardConfig ?? {}) as Record<string, unknown>;
  const numOrNull = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status === "active" ? "active" : "disabled",
    delivery: row.delivery as OfferDelivery,
    code: row.code,
    priority: row.priority,
    triggerType: row.triggerType as OfferTriggerType,
    minSubtotal: numOrNull(trigger.minSubtotal),
    rewardType: row.rewardType as OfferRewardType,
    percent: numOrNull(reward.percent),
    amount: numOrNull(reward.amount),
    unitPrice: numOrNull(reward.unitPrice),
    channels: (row.channels ?? []) as OfferChannel[],
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    maxRedemptions: row.maxRedemptions,
    maxPerCustomer: row.maxPerCustomer,
    budget: row.budgetPaise === null ? null : row.budgetPaise / 100,
    redemptionCount: row.redemptionCount,
    spent: (row.spentPaise ?? 0) / 100,
    createdAt: row.createdAt,
  };
}

// --- Writes -----------------------------------------------------------------

export async function createOffer(form: OfferFormData): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const invalid = validateForm(form);
  if (invalid) return { error: invalid };

  const scopeError = await checkScopeEntitlements(storeId, form);
  if (scopeError) return { error: scopeError };

  let created: OfferRow;
  try {
    created = await withService(async (db) => {
      // ★ INSIDE THE TRANSACTION, under the same advisory lock, so a plan
      // downgrade or a second tab racing this cannot overshoot the cap.
      if (form.status === "active") {
        await assertCanActivateOffer(db, storeId);
      }
      const [row] = await db
        .insert(offers)
        .values({ ...buildRow(form, admin.uid, true), storeId })
        .returning();
      await syncScopes(
        db,
        storeId,
        row.id,
        form.locationIds ?? [],
        form.groupIds ?? [],
        form.productIds ?? [],
        form.variantIds ?? [],
        form.categoryIds ?? [],
      );
      return mapRow(row);
    });
  } catch (err) {
    if (err instanceof PlanEntitlementError) return { error: err.message };
    if (isUniqueViolation(err)) {
      return { error: "An offer with that code already exists." };
    }
    console.error("createOffer error:", err);
    return { error: dbErrorMessage(err, "Failed to create the offer.") };
  }

  emitEvent({
    type: "coupon.created",
    storeId,
    actor: { type: "admin", id: admin.uid },
    subject: { type: "coupon", id: created.id, label: created.name },
    payload: { code: created.code ?? created.name },
  });

  revalidateOffers();
  return { success: true, data: { id: created.id } };
}

export async function updateOffer(
  id: string,
  form: OfferFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const invalid = validateForm(form);
  if (invalid) return { error: invalid };

  const scopeError = await checkScopeEntitlements(storeId, form);
  if (scopeError) return { error: scopeError };

  try {
    const changed = await withService(async (db) => {
      if (form.status === "active") {
        await assertCanActivateOffer(db, storeId, id);
      }
      const rows = await db
        .update(offers)
        .set(buildRow(form, admin.uid, false))
        .where(and(eq(offers.id, id), eq(offers.storeId, storeId)))
        .returning({ id: offers.id });
      if (rows.length === 0) return false;
      await syncScopes(
        db,
        storeId,
        id,
        form.locationIds ?? [],
        form.groupIds ?? [],
        form.productIds ?? [],
        form.variantIds ?? [],
        form.categoryIds ?? [],
      );
      return true;
    });
    if (!changed) return { error: "Offer not found." };
  } catch (err) {
    if (err instanceof PlanEntitlementError) return { error: err.message };
    if (isUniqueViolation(err)) {
      return { error: "An offer with that code already exists." };
    }
    console.error("updateOffer error:", err);
    return { error: dbErrorMessage(err, "Failed to save the offer.") };
  }

  revalidateOffers();
  return { success: true };
}

/**
 * Turn an offer on or off.
 *
 * Its own action rather than a full `updateOffer`, because pausing a runaway
 * offer is the thing a merchant does in a hurry — it must not require the form
 * to re-validate, and it must not be able to fail because some unrelated field
 * is now invalid.
 */
export async function setOfferStatus(
  id: string,
  status: OfferStatus,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  try {
    const changed = await withService(async (db) => {
      if (status === "active") {
        await assertCanActivateOffer(db, storeId, id);
      }
      const rows = await db
        .update(offers)
        .set({
          status,
          updatedBy: admin.uid,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(offers.id, id), eq(offers.storeId, storeId)))
        .returning({ id: offers.id });
      return rows.length > 0;
    });
    if (!changed) return { error: "Offer not found." };
  } catch (err) {
    if (err instanceof PlanEntitlementError) return { error: err.message };
    console.error("setOfferStatus error:", err);
    return { error: dbErrorMessage(err, "Failed to change the offer.") };
  }

  revalidateOffers();
  return { success: true };
}

/**
 * Delete an offer.
 *
 * ★ REDEMPTIONS AND PER-LINE RECORDS SURVIVE. `order_item_offers.offer_id` is
 * ON DELETE SET NULL with the offer's NAME snapshotted beside it, so deleting
 * an offer never changes what an issued invoice says or erases the record of
 * what an order was charged. `offer_redemptions` cascades, which is why the
 * dashboard warns before deleting rather than after.
 */
export async function deleteOffer(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  try {
    const rows = await withService((db) =>
      db
        .delete(offers)
        .where(and(eq(offers.id, id), eq(offers.storeId, storeId)))
        .returning({ id: offers.id }),
    );
    if (rows.length === 0) return { error: "Offer not found." };
  } catch (err) {
    console.error("deleteOffer error:", err);
    return { error: dbErrorMessage(err, "Failed to delete the offer.") };
  }

  revalidateOffers();
  return { success: true };
}

/**
 * Plan gates on the SCOPES an offer uses, checked before any write.
 *
 * Customer groups are Basic+, so a free store must not be able to restrict an
 * offer to one — the same rule `createCoupon` applies. The offer cap itself is
 * enforced transactionally by `assertCanActivateOffer`.
 */
async function checkScopeEntitlements(
  storeId: string,
  form: OfferFormData,
): Promise<string | null> {
  if ((form.groupIds?.length ?? 0) > 0) {
    const allowed = await storeAllowsPlanFeature(storeId, "customerGroups");
    if (!allowed) {
      return "Restricting an offer to customer groups is available on Basic and Pro.";
    }
  }
  return null;
}

/**
 * How many active offers this store has and may have, for the list header.
 *
 * ★ NO `export type` FROM THIS FILE, EVER. Every export of a `"use server"`
 * module is registered as a server action, so a re-exported type emits an
 * action reference for a binding erasure has already removed — and `tsc` and
 * `eslint` BOTH pass while `next build` fails with "Export X doesn't exist in
 * target module". Consumers import the types from `@/lib/offers/types`
 * directly. (Third instance of this trap in the codebase; CODEBASE.md §34.)
 */
export async function getOfferCapacity(): Promise<{
  limit: number | null;
  active: number;
}> {
  const admin = await getAdminIdentity();
  if (!admin) return { limit: null, active: 0 };
  const storeId = await getActingStoreId();
  const { offerCapacity } = await import("@/lib/offers/resolve");
  return offerCapacity(storeId);
}
