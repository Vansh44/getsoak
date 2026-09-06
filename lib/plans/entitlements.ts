import "server-only";

import { and, count, eq, ne, sql } from "drizzle-orm";
import { admins, coupons, products, stores } from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import {
  effectivePlan,
  PLAN_LIMITS,
  type Plan,
  type PlanFeature,
  type PlanLimits,
} from "@/lib/plans";

export interface StorePlanContext {
  plan: Plan;
  limits: PlanLimits;
}

export class PlanEntitlementError extends Error {
  readonly code = "PLAN_ENTITLEMENT";

  constructor(message: string) {
    super(message);
    this.name = "PlanEntitlementError";
  }
}

async function planContextWithDb(
  db: Db,
  storeId: string,
): Promise<StorePlanContext> {
  const [store] = await db
    .select({
      plan: stores.plan,
      expiresAt: stores.planExpiresAt,
      compPlan: stores.compPlan,
      compExpiresAt: stores.compExpiresAt,
    })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  const plan = effectivePlan({
    plan: store?.plan,
    plan_expires_at: store?.expiresAt,
    comp_plan: store?.compPlan ?? null,
    comp_expires_at: store?.compExpiresAt ?? null,
  });
  return { plan, limits: PLAN_LIMITS[plan] };
}

/** Current plan and limits, with timed-plan expiry applied immediately. */
export async function getStorePlanContext(
  storeId: string,
): Promise<StorePlanContext> {
  return withService((db) => planContextWithDb(db, storeId));
}

export async function storeAllowsPlanFeature(
  storeId: string,
  feature: PlanFeature,
): Promise<boolean> {
  const { limits } = await getStorePlanContext(storeId);
  return limits[feature];
}

export async function assertStorePlanFeature(
  storeId: string,
  feature: PlanFeature,
  message: string,
): Promise<void> {
  if (!(await storeAllowsPlanFeature(storeId, feature))) {
    throw new PlanEntitlementError(message);
  }
}

async function lockLimit(db: Db, storeId: string, resource: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`plan-limit:${resource}:${storeId}`}, 0))`,
  );
}

/**
 * Run inside the SAME transaction as the product INSERT. The advisory lock
 * serialises concurrent creates, so two requests cannot both observe the last
 * free slot. Downgrades never call this for edits/deletes: all existing rows
 * stay visible and editable; only net-new rows above the current cap stop.
 */
export async function assertCanCreateProduct(db: Db, storeId: string) {
  const capacity = await getProductCreateCapacity(db, storeId, 1);
  if (capacity.allowed === 0) {
    throw new PlanEntitlementError(capacity.error);
  }
}

export interface ProductCreateCapacity {
  allowed: number;
  error: string;
}

/**
 * Reserve up to `requested` product inserts inside the caller's transaction.
 * The advisory lock remains held until that transaction commits, so a CSV
 * slice can read the plan/count once, insert every allowed row, and prevent a
 * concurrent editor/import from taking the same slots.
 */
export async function getProductCreateCapacity(
  db: Db,
  storeId: string,
  requested: number,
): Promise<ProductCreateCapacity> {
  await lockLimit(db, storeId, "products");
  const { plan, limits } = await planContextWithDb(db, storeId);
  const safeRequested = Math.max(0, Math.trunc(requested));
  const error = `${plan === "free" ? "Free" : "Basic"} includes up to ${limits.maxProducts ?? "unlimited"} products. Upgrade to add another product; your existing products remain safe.`;
  if (limits.maxProducts === null) {
    return { allowed: safeRequested, error };
  }
  const [row] = await db
    .select({ n: count() })
    .from(products)
    .where(eq(products.storeId, storeId));
  const available = Math.max(0, limits.maxProducts - (row?.n ?? 0));
  return { allowed: Math.min(safeRequested, available), error };
}

/** Same soft-limit rule as products; staff already present are never removed. */
export async function assertCanInviteStaff(db: Db, storeId: string) {
  await lockLimit(db, storeId, "staff");
  const { plan, limits } = await planContextWithDb(db, storeId);
  if (limits.maxStaff === null) return;
  const [row] = await db
    .select({ n: count() })
    .from(admins)
    .where(eq(admins.storeId, storeId));
  if ((row?.n ?? 0) >= limits.maxStaff) {
    throw new PlanEntitlementError(
      `${plan === "free" ? "Free" : "Basic"} includes ${limits.maxStaff} staff account${limits.maxStaff === 1 ? "" : "s"}, including the owner. Upgrade to invite someone new; existing staff data remains safe.`,
    );
  }
}

/** Check only when a coupon is being created/changed to active. Existing
 * active coupons survive a downgrade and disabled coupons can still be saved. */
export async function assertCanActivateCoupon(
  db: Db,
  storeId: string,
  excludeCouponId?: string,
) {
  await assertCanActivateDiscount(db, storeId, excludeCouponId, "coupons");
}

/**
 * How many discounts this store is running, counting the MERGED pool.
 *
 * ★★ ONE POOL, BECAUSE A COUPON IS AN OFFER NOW (docs/offers-plan.md §2).
 * `assertCanActivateOffer` counted `offers` and `assertCanActivateCoupon`
 * counted `coupons`, under DIFFERENT advisory locks — so a Free store ran three
 * of each, six concurrent discounts on a plan that allows three, and two
 * simultaneous writes could not even see one another. `assertCanActivateOffer`'s
 * own docblock said it counted the merged pool; it never did.
 *
 * ★ A UNION ON `id` IS EXACT, and that is not a coincidence: migration 0059
 * inserts each offer with `SELECT c.id`, so a migrated coupon and its offer
 * SHARE a primary key. The union therefore counts it once, while a coupon that
 * never migrated (a stored code not in normal form) or one written since (Mink
 * Phase 4C still creates `coupons`) has an id in only one table and counts
 * once too. Summing the two counts would double every migrated coupon.
 *
 * ★ AND THE EXCLUSION WORKS ACROSS BOTH for the same reason — editing a
 * migrated coupon excludes its row from both halves with one id.
 */
async function countActiveDiscounts(
  db: Db,
  storeId: string,
  excludeId?: string,
): Promise<number> {
  // ★ THE DEPLOY WINDOW. DDL is a separate release gate, so this code reaches
  // production before 20260902_0059 does — and a query naming a table that does
  // not exist yet would abort the whole transaction, taking coupon creation
  // down with it. `to_regclass` answers without throwing; before the migration
  // the pool is simply the coupons, which is exactly what it was.
  const probe = await db.execute(
    sql`select to_regclass('public.offers') is not null as ready`,
  );
  const offersReady =
    (probe.rows[0] as { ready: boolean | null } | undefined)?.ready === true;

  if (!offersReady) {
    const condition = excludeId
      ? and(
          eq(coupons.storeId, storeId),
          eq(coupons.status, "active"),
          ne(coupons.id, excludeId),
        )
      : and(eq(coupons.storeId, storeId), eq(coupons.status, "active"));
    const [row] = await db
      .select({ n: count() })
      .from(coupons)
      .where(condition);
    return row?.n ?? 0;
  }

  const merged = await db.execute(sql`
    select count(*)::int as n
      from (
        select id from public.offers
         where store_id = ${storeId}::uuid and status = 'active'
        union
        select id from public.coupons
         where store_id = ${storeId}::uuid and status = 'active'
      ) t
     where ${excludeId ?? null}::uuid is null or t.id <> ${excludeId ?? null}::uuid
  `);
  return Number((merged.rows[0] as { n: number | null } | undefined)?.n ?? 0);
}

/**
 * The shared gate. `noun` only chooses the wording — a merchant reaching the
 * cap from the coupon screen should be told about coupons — while the pool, the
 * lock and the limit are the same for both surfaces.
 */
async function assertCanActivateDiscount(
  db: Db,
  storeId: string,
  excludeId: string | undefined,
  noun: "offers" | "coupons",
) {
  // ★ ONE LOCK FOR ONE POOL. Two keys meant a coupon write and an offer write
  // could pass simultaneously and both land, which is the race the lock exists
  // to close.
  await lockLimit(db, storeId, "active-discounts");
  const { plan, limits } = await planContextWithDb(db, storeId);
  // `maxActiveOffers` governs both; `maxActiveCoupons` stays in the catalog
  // until nothing reads it, and the two are equal on every plan.
  const cap = limits.maxActiveOffers;
  if (cap === null) return;
  const active = await countActiveDiscounts(db, storeId, excludeId);
  if (active >= cap) {
    throw new PlanEntitlementError(
      `${plan === "free" ? "Free" : "Basic"} includes up to ${cap} active ${noun}. Disable one or upgrade; existing ${noun} remain safe.`,
    );
  }
}

/**
 * Run inside the same transaction as an offer activation.
 *
 * ★ COUNTS THE MERGED POOL. Coupons became offers (docs/offers-plan.md §2), so
 * counting `coupons` and `offers` separately would hand a free store three of
 * each — which is the bypass the single cap exists to close.
 *
 * Soft downgrade follows the platform contract: an over-cap offer is never
 * deleted, only prevented from being newly activated, and the same stored
 * offer becomes available again on re-upgrade.
 */
export async function assertCanActivateOffer(
  db: Db,
  storeId: string,
  excludeOfferId?: string,
) {
  await assertCanActivateDiscount(db, storeId, excludeOfferId, "offers");
}

/** Run inside the same transaction as a Mink/customer-group INSERT so a plan
 * downgrade racing the create cannot bypass the feature gate. Existing groups
 * remain editable after downgrade; only net-new groups are gated. */
export async function assertCanCreateCustomerGroup(db: Db, storeId: string) {
  await lockLimit(db, storeId, "customer-groups");
  const { limits } = await planContextWithDb(db, storeId);
  if (!limits.customerGroups) {
    throw new PlanEntitlementError(
      "Customer groups are available on Basic and Pro. Upgrade to create a new group; existing groups and memberships remain safe.",
    );
  }
}
