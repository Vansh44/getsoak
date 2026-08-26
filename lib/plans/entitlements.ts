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
    .select({ plan: stores.plan, expiresAt: stores.planExpiresAt })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  const plan = effectivePlan({
    plan: store?.plan,
    plan_expires_at: store?.expiresAt,
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
  await lockLimit(db, storeId, "active-coupons");
  const { plan, limits } = await planContextWithDb(db, storeId);
  if (limits.maxActiveCoupons === null) return;
  const condition = excludeCouponId
    ? and(
        eq(coupons.storeId, storeId),
        eq(coupons.status, "active"),
        ne(coupons.id, excludeCouponId),
      )
    : and(eq(coupons.storeId, storeId), eq(coupons.status, "active"));
  const [row] = await db.select({ n: count() }).from(coupons).where(condition);
  if ((row?.n ?? 0) >= limits.maxActiveCoupons) {
    throw new PlanEntitlementError(
      `${plan === "free" ? "Free" : "Basic"} includes up to ${limits.maxActiveCoupons} active coupons. Disable one or upgrade; existing coupons remain safe.`,
    );
  }
}
