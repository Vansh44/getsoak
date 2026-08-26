"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import {
  withAnon,
  withUser,
  type Db,
  type UserIdentity,
} from "@/lib/db/client";
import { isUniqueViolation, dbErrorMessage } from "@/lib/db/errors";
import { coupons, couponUserGroups, userGroupMembers } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import {
  getManagerIdentity,
  getActingStoreId,
  getViewerContext,
} from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { can } from "@/app/dashboard/lib/permissions";
import { TAGS } from "@/lib/storefront/tags";
import { getCurrentStore } from "@/lib/store/resolve";
import { resolveStoreSettings } from "@/lib/settings/registry";
import {
  assertCanActivateCoupon,
  PlanEntitlementError,
  storeAllowsPlanFeature,
} from "@/lib/plans/entitlements";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscountType = "percentage" | "fixed";

export interface CouponFormData {
  code: string;
  description: string;
  discount_type: DiscountType;
  discount_value: number;
  min_order_amount: number; // 0 = no minimum
  max_uses: number; // 0 = unlimited
  valid_from: string; // "" or yyyy-mm-dd
  valid_until: string; // "" or yyyy-mm-dd
  status: "active" | "disabled";
  show_on_storefront: boolean;
  // User group ids this coupon is restricted to. Empty / omitted = public.
  restricted_group_ids?: string[];
}

export interface ActionResult {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// What the storefront receives when a code validates: enough to recompute the
// discount locally as the cart changes, without trusting the client on price.
export interface AppliedCoupon {
  code: string;
  discountType: DiscountType;
  discountValue: number;
  minOrderAmount: number;
}

export interface ValidateResult {
  coupon?: AppliedCoupon;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Coupon codes are case-insensitive: stored and matched uppercased, no spaces.
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

// Allowed when the caller's role grants `manage` on the Marketing section.
async function getAdminIdentity(): Promise<UserIdentity | null> {
  return getManagerIdentity("marketing");
}

// Turn a date input ("" | "yyyy-mm-dd") into an ISO timestamp or null.
function toTimestamp(value: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildRow(form: CouponFormData, userId: string, creating: boolean) {
  const num = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return {
    code: normalizeCode(form.code),
    description: form.description.trim() || null,
    discountType: form.discount_type,
    discountValue: num(form.discount_value),
    minOrderAmount: num(form.min_order_amount),
    maxUses: Number.isFinite(form.max_uses)
      ? Math.trunc(Math.max(0, form.max_uses))
      : 0,
    status: form.status,
    validFrom: toTimestamp(form.valid_from),
    validUntil: toTimestamp(form.valid_until),
    showOnStorefront: form.show_on_storefront,
    updatedBy: userId,
    ...(creating ? { createdBy: userId } : {}),
  };
}

function validateForm(form: CouponFormData): string | null {
  if (!normalizeCode(form.code)) return "Coupon code is required.";
  if (!(form.discount_value > 0))
    return "Discount value must be greater than 0.";
  if (form.discount_type === "percentage" && form.discount_value > 100)
    return "A percentage discount can't exceed 100%.";
  const from = toTimestamp(form.valid_from);
  const until = toTimestamp(form.valid_until);
  if (from && until && new Date(from) > new Date(until))
    return "“Valid from” must be before “Valid until”.";
  return null;
}

function revalidateCoupons() {
  revalidatePath("/dashboard/marketing/coupons");
  // Bust the cached storefront coupon-discovery list so the cart reflects
  // create/edit/delete/visibility changes immediately.
  revalidateTag(TAGS.coupons, "max");
}

// Replace a coupon's group restrictions with `groupIds` (clear + insert).
// Empty list leaves the coupon public. Best-effort: a failure (e.g. table not
// yet migrated) is logged, not fatal — the coupon itself still saves. Runs
// under the admin's identity so RLS applies.
async function syncCouponGroups(
  admin: UserIdentity,
  couponId: string,
  groupIds: string[] | undefined,
  storeId: string,
): Promise<void> {
  const ids = Array.from(new Set((groupIds ?? []).filter(Boolean)));

  try {
    await withUser(admin, (db) =>
      db
        .delete(couponUserGroups)
        .where(eq(couponUserGroups.couponId, couponId)),
    );
  } catch (err) {
    console.error("syncCouponGroups (clear) error:", err);
    return;
  }

  if (ids.length === 0) return;

  const rows = ids.map((groupId) => ({
    couponId,
    groupId,
    storeId,
  }));
  try {
    await withUser(admin, (db) => db.insert(couponUserGroups).values(rows));
  } catch (err) {
    console.error("syncCouponGroups (insert) error:", err);
  }
}

// Returns an error message if a group-restricted coupon can't be used by the
// current caller, or null when it's allowed (incl. public coupons). The links
// are publicly readable (anon scope); membership is checked under the
// signed-in customer's identity, where RLS scopes user_group_members to their
// own rows.
async function checkGroupRestriction(couponId: string): Promise<string | null> {
  let groupIds: string[];
  try {
    const links = await withAnon((db) =>
      db
        .select({ group_id: couponUserGroups.groupId })
        .from(couponUserGroups)
        .where(eq(couponUserGroups.couponId, couponId)),
    );
    groupIds = links.map((l) => l.group_id);
  } catch (err) {
    // Table not migrated / unreadable: treat the coupon as public rather than
    // blocking a legitimate code.
    console.error("checkGroupRestriction (links) error:", err);
    return null;
  }

  if (groupIds.length === 0) return null; // public coupon

  const user = await getServerUser();
  if (!user) return "Sign in to use this coupon.";

  try {
    const memberships = await withUser(
      { uid: user.id, email: user.email },
      (db) =>
        db
          .select({ group_id: userGroupMembers.groupId })
          .from(userGroupMembers)
          .where(
            and(
              eq(userGroupMembers.userId, user.id),
              inArray(userGroupMembers.groupId, groupIds),
            ),
          ),
    );
    if (memberships.length === 0)
      return "This coupon isn’t available for your account.";
    return null;
  } catch (err) {
    console.error("checkGroupRestriction (membership) error:", err);
    return "Could not verify this coupon for your account. Please try again.";
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createCoupon(
  form: CouponFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  const storeId = await getActingStoreId();

  const invalid = validateForm(form);
  if (invalid) return { error: invalid };

  const allowsGroups = await storeAllowsPlanFeature(storeId, "customerGroups");
  if (!allowsGroups && (form.restricted_group_ids?.length ?? 0) > 0) {
    return {
      error:
        "Customer-group coupon restrictions are available on Basic and Pro.",
    };
  }

  let created: Record<string, unknown>;
  try {
    const [row] = await withUser(admin, async (db) => {
      if (form.status === "active") {
        await assertCanActivateCoupon(db, storeId);
      }
      return db
        .insert(coupons)
        .values({ ...buildRow(form, userId, true), storeId })
        .returning();
    });
    created = row as Record<string, unknown>;
  } catch (err) {
    if (err instanceof PlanEntitlementError) return { error: err.message };
    if (isUniqueViolation(err))
      return { error: "A coupon with that code already exists." };
    console.error("createCoupon error:", err);
    return { error: dbErrorMessage(err, "Failed to create coupon.") };
  }

  await syncCouponGroups(
    admin,
    created.id as string,
    form.restricted_group_ids,
    storeId,
  );

  emitEvent({
    type: "coupon.created",
    storeId,
    actor: { type: "admin", id: userId },
    subject: {
      type: "coupon",
      id: created.id as string,
      label: created.code as string,
    },
    payload: { code: String(created.code ?? "") },
  });

  revalidateCoupons();
  return { success: true, data: created };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateCoupon(
  id: string,
  form: CouponFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  const storeId = await getActingStoreId();

  const invalid = validateForm(form);
  if (invalid) return { error: invalid };

  const allowsGroups = await storeAllowsPlanFeature(storeId, "customerGroups");

  try {
    // RLS (is_store_admin) confines the update to the caller's own store.
    await withUser(admin, async (db) => {
      const [existing] = await db
        .select({ status: coupons.status })
        .from(coupons)
        .where(and(eq(coupons.id, id), eq(coupons.storeId, storeId)))
        .limit(1);
      if (!existing) throw new Error("Coupon not found.");
      if (existing.status !== "active" && form.status === "active") {
        await assertCanActivateCoupon(db, storeId, id);
      }
      return db
        .update(coupons)
        .set(buildRow(form, userId, false))
        .where(and(eq(coupons.id, id), eq(coupons.storeId, storeId)));
    });
  } catch (err) {
    if (err instanceof PlanEntitlementError) return { error: err.message };
    if (isUniqueViolation(err))
      return { error: "A coupon with that code already exists." };
    console.error("updateCoupon error:", err);
    return { error: dbErrorMessage(err, "Failed to update coupon.") };
  }

  // A downgrade makes group restrictions read-only. Never clear the join rows
  // simply because the locked selector was absent from a submitted form.
  if (allowsGroups) {
    await syncCouponGroups(admin, id, form.restricted_group_ids, storeId);
  }

  revalidateCoupons();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteCoupon(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };

  try {
    // RLS (is_store_admin) confines the delete to the caller's own store.
    await withUser(admin, (db) => db.delete(coupons).where(eq(coupons.id, id)));
  } catch (err) {
    console.error("deleteCoupon error:", err);
    return { error: dbErrorMessage(err, "Failed to delete coupon.") };
  }

  revalidateCoupons();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Validate (storefront — callable by anonymous shoppers)
//
// RLS only exposes ACTIVE coupons, so an unknown OR disabled code reads as
// "invalid". Date / usage / minimum checks run here so the cart can show a
// specific reason. Returns the rule (type/value/min) so the cart recomputes
// the discount locally as quantities change.
// ---------------------------------------------------------------------------

export async function validateCoupon(
  rawCode: string,
  subtotal: number,
): Promise<ValidateResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { error: "Enter a coupon code." };

  const storeId = await getActingStoreId();

  let data:
    | {
        id: string;
        code: string;
        discount_type: string;
        discount_value: number;
        min_order_amount: number;
        max_uses: number;
        used_count: number;
        valid_from: string | null;
        valid_until: string | null;
      }
    | undefined;
  try {
    // Signed-in callers run under their identity (same RLS view as the old
    // cookie client — e.g. a store admin can validate their own disabled
    // code); everyone else is anonymous (active coupons only).
    const run = (db: Db) =>
      db
        .select({
          id: coupons.id,
          code: coupons.code,
          discount_type: coupons.discountType,
          discount_value: coupons.discountValue,
          min_order_amount: coupons.minOrderAmount,
          max_uses: coupons.maxUses,
          used_count: coupons.usedCount,
          valid_from: coupons.validFrom,
          valid_until: coupons.validUntil,
        })
        .from(coupons)
        .where(and(eq(coupons.code, code), eq(coupons.storeId, storeId)))
        .limit(1);
    const user = await getServerUser();
    const rows = user
      ? await withUser({ uid: user.id, email: user.email }, run)
      : await withAnon(run);
    data = rows[0];
  } catch (err) {
    console.error("validateCoupon error:", err);
    return { error: "Could not check that code. Please try again." };
  }
  if (!data) return { error: "Invalid or expired coupon code." };

  // Group restriction: a coupon linked to one or more user groups can only be
  // applied by a signed-in customer who belongs to one of them. Public coupons
  // (no links) skip this entirely.
  const restriction = await checkGroupRestriction(data.id);
  if (restriction) return { error: restriction };

  const now = Date.now();
  if (data.valid_from && new Date(data.valid_from).getTime() > now)
    return { error: "This coupon isn’t active yet." };
  if (data.valid_until && new Date(data.valid_until).getTime() < now)
    return { error: "This coupon has expired." };

  if (data.max_uses > 0 && data.used_count >= data.max_uses)
    return { error: "This coupon has reached its usage limit." };

  const minOrder = Number(data.min_order_amount) || 0;
  if (minOrder > 0 && subtotal < minOrder)
    return {
      error: `Add ₹${(minOrder - subtotal).toLocaleString(
        "en-IN",
      )} more to use this coupon (min ₹${minOrder.toLocaleString("en-IN")}).`,
    };

  return {
    coupon: {
      code: data.code,
      discountType: data.discount_type as DiscountType,
      discountValue: Number(data.discount_value) || 0,
      minOrderAmount: minOrder,
    },
  };
}

// ---------------------------------------------------------------------------
// Storefront Discovery
// ---------------------------------------------------------------------------

export interface AvailableCoupon {
  code: string;
  description: string | null;
  discount_type: DiscountType;
  discount_value: number;
  min_order_amount: number;
}

// Cached, cookieless read of a store's shopper-visible coupons. Runs in the
// anonymous scope (only ACTIVE coupons are anon-readable via RLS, and we
// return no admin-only columns), so it is safe to serve from a shared cache.
// Keyed by (storeId, showAll) — each store + toggle state gets its own entry —
// and tagged TAGS.coupons so any coupon create/edit/delete/visibility change
// (revalidateCoupons) busts it. Called from CouponField on mount; caching keeps
// that from hitting the DB on every page load.
const getStorefrontCouponsCached = unstable_cache(
  async (storeId: string, showAll: boolean): Promise<AvailableCoupon[]> => {
    const conds = [eq(coupons.storeId, storeId), eq(coupons.status, "active")];
    if (!showAll) {
      conds.push(eq(coupons.showOnStorefront, true));
    }

    let rows: {
      code: string;
      description: string | null;
      discount_type: string;
      discount_value: number;
      min_order_amount: number;
      valid_from: string | null;
      valid_until: string | null;
      max_uses: number;
      used_count: number;
    }[];
    try {
      rows = await withAnon((db) =>
        db
          .select({
            code: coupons.code,
            description: coupons.description,
            discount_type: coupons.discountType,
            discount_value: coupons.discountValue,
            min_order_amount: coupons.minOrderAmount,
            valid_from: coupons.validFrom,
            valid_until: coupons.validUntil,
            max_uses: coupons.maxUses,
            used_count: coupons.usedCount,
          })
          .from(coupons)
          .where(and(...conds)),
      );
    } catch (err) {
      console.error(
        "getStorefrontCoupons:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }

    const now = Date.now();
    return rows
      .filter((c) => {
        if (c.valid_from && new Date(c.valid_from).getTime() > now)
          return false;
        if (c.valid_until && new Date(c.valid_until).getTime() < now)
          return false;
        if (c.max_uses > 0 && c.used_count >= c.max_uses) return false;
        return true;
      })
      .map((c) => ({
        code: c.code,
        description: c.description,
        discount_type: c.discount_type as DiscountType,
        discount_value: Number(c.discount_value) || 0,
        min_order_amount: Number(c.min_order_amount) || 0,
      }));
  },
  ["storefront-available-coupons"],
  { tags: [TAGS.coupons], revalidate: 300 },
);

export async function getAvailableStorefrontCoupons(): Promise<
  AvailableCoupon[]
> {
  const store = await getCurrentStore();
  const settings = resolveStoreSettings(store.settings, store.plan);
  const showAll = Boolean(settings["marketing.showAllCoupons"]);
  return getStorefrontCouponsCached(store.id, showAll);
}

export async function toggleCouponVisibility(
  id: string,
  show: boolean,
): Promise<{ success?: boolean; error?: string }> {
  const ctx = await getViewerContext();
  if (ctx?.dbError) return { error: "Couldn't reach the database. Try again." };
  if (!ctx?.profile) return { error: "Not authenticated" };

  if (!can(ctx.permissions, "marketing", "manage", ctx.isSuperadmin)) {
    return { error: "You don't have permission to manage coupons." };
  }

  const user = await getServerUser();
  if (!user) return { error: "Not authenticated" };

  try {
    // Explicit store scope on top of RLS — no admin can flip another store's coupon.
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .update(coupons)
        .set({ showOnStorefront: show })
        .where(and(eq(coupons.id, id), eq(coupons.storeId, ctx.storeId))),
    );
  } catch (err) {
    console.error(
      "toggleCouponVisibility:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Failed to update coupon visibility." };
  }

  revalidateCoupons();
  return { success: true };
}
