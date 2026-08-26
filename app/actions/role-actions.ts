"use server";

import { and, count, eq, like } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getServerUser } from "@/lib/auth/server-user";
import { withService, withUser, type Db } from "@/lib/db/client";
import { isUniqueViolation, dbErrorMessage } from "@/lib/db/errors";
import { admins, roles } from "@/drizzle/schema";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import {
  normalizePermissions,
  SUPERADMIN_SLUG,
  type RolePermissions,
  ROLE_COLORS,
} from "@/app/dashboard/lib/permissions";
import { storeAllowsPlanFeature } from "@/lib/plans/entitlements";

async function rolesPlanError(storeId: string): Promise<string | null> {
  return (await storeAllowsPlanFeature(storeId, "customRoles"))
    ? null
    : "Custom roles are available on Basic and Pro. Existing roles and assignments remain safe until you upgrade.";
}

export interface RoleFormData {
  name: string;
  description: string;
  color: string;
  permissions: RolePermissions;
}

export interface RoleActionResult {
  success?: boolean;
  error?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Only a superadmin (or a role granted roles.manage) may administer roles.
// Returns the caller's id when allowed, else null. Reads run under the caller's
// identity (RLS-scoped) — admins can read their own row and roles are readable.
async function requireRolesManager(): Promise<string | null> {
  const user = await getServerUser();
  if (!user) return null;

  try {
    return await withUser({ uid: user.id, email: user.email }, async (db) => {
      const profileRows = await db
        .select({ role: admins.role })
        .from(admins)
        .where(eq(admins.id, user.id))
        .limit(1);
      const slug = profileRows[0]?.role;
      if (!slug) return null;
      if (slug === SUPERADMIN_SLUG) return user.id;

      const roleRows = await db
        .select({ permissions: roles.permissions })
        .from(roles)
        .where(eq(roles.slug, slug))
        .limit(1);
      const perms = normalizePermissions(roleRows[0]?.permissions);
      return perms.roles?.includes("manage") ? user.id : null;
    });
  } catch (err) {
    console.error("requireRolesManager error:", err);
    return null;
  }
}

function validate(form: RoleFormData): string | null {
  if (!form.name.trim()) return "Role name is required.";
  if (form.name.trim().length > 40) return "Role name is too long.";
  if (!ROLE_COLORS.includes(form.color as (typeof ROLE_COLORS)[number])) {
    return "Invalid colour.";
  }
  return null;
}

// Resolve the first free slug for `base` within this store's roles. Runs inside
// the caller's service transaction (pass the db handle).
async function resolveUniqueSlug(db: Db, base: string): Promise<string> {
  const safeBase = base || "role";
  const rows = await db
    .select({ slug: roles.slug })
    .from(roles)
    .where(like(roles.slug, `${safeBase}%`));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(safeBase)) return safeBase;
  let n = 2;
  while (taken.has(`${safeBase}-${n}`)) n++;
  return `${safeBase}-${n}`;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createRole(
  form: RoleFormData,
): Promise<RoleActionResult> {
  const callerId = await requireRolesManager();
  if (!callerId)
    return { error: "You do not have permission to manage roles." };
  const storeId = await getActingStoreId();
  const planError = await rolesPlanError(storeId);
  if (planError) return { error: planError };

  const invalid = validate(form);
  if (invalid) return { error: invalid };

  try {
    await withService(async (db) => {
      const slug = await resolveUniqueSlug(db, slugify(form.name));
      await db.insert(roles).values({
        name: form.name.trim(),
        slug,
        description: form.description.trim() || null,
        color: form.color,
        permissions: normalizePermissions(form.permissions),
        isSystem: false,
        storeId,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "A role with that name already exists." };
    }
    console.error("createRole error:", err);
    return { error: dbErrorMessage(err, "Failed to create role.") };
  }

  revalidatePath("/dashboard/roles");
  revalidatePath("/dashboard/admins");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateRole(
  id: string,
  form: RoleFormData,
): Promise<RoleActionResult> {
  const callerId = await requireRolesManager();
  if (!callerId)
    return { error: "You do not have permission to manage roles." };

  const invalid = validate(form);
  if (invalid) return { error: invalid };

  // Scope every query by store_id — the service scope bypasses RLS, so an id
  // alone would let a store's roles manager edit another store's roles.
  const storeId = await getActingStoreId();
  const planError = await rolesPlanError(storeId);
  if (planError) return { error: planError };

  const existingRows = await withService((db) =>
    db
      .select({ slug: roles.slug, is_system: roles.isSystem })
      .from(roles)
      .where(and(eq(roles.id, id), eq(roles.storeId, storeId)))
      .limit(1),
  ).catch(() => []);
  const existing = existingRows[0];
  if (!existing) return { error: "Role not found." };

  // System roles keep their slug and stay non-deletable, but their name,
  // description, colour and permissions can be tuned — except the superadmin
  // role, whose all-access is enforced in code and must not be weakened here.
  const set =
    existing.slug === SUPERADMIN_SLUG
      ? {
          name: form.name.trim(),
          description: form.description.trim() || null,
          color: form.color,
        }
      : {
          name: form.name.trim(),
          description: form.description.trim() || null,
          color: form.color,
          permissions: normalizePermissions(form.permissions),
        };

  try {
    await withService((db) =>
      db
        .update(roles)
        .set(set)
        .where(and(eq(roles.id, id), eq(roles.storeId, storeId))),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "A role with that name already exists." };
    }
    console.error("updateRole error:", err);
    return { error: dbErrorMessage(err, "Failed to update role.") };
  }

  revalidatePath("/dashboard/roles");
  revalidatePath("/dashboard/admins");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteRole(id: string): Promise<RoleActionResult> {
  const callerId = await requireRolesManager();
  if (!callerId)
    return { error: "You do not have permission to manage roles." };

  const storeId = await getActingStoreId();
  const planError = await rolesPlanError(storeId);
  if (planError) return { error: planError };

  const roleRows = await withService((db) =>
    db
      .select({ slug: roles.slug, is_system: roles.isSystem })
      .from(roles)
      .where(and(eq(roles.id, id), eq(roles.storeId, storeId)))
      .limit(1),
  ).catch(() => []);
  const role = roleRows[0];
  if (!role) return { error: "Role not found." };
  if (role.is_system) {
    return { error: "System roles cannot be deleted." };
  }

  // Block deletion while admins OF THIS STORE still hold this role — they'd be
  // left with no permissions. Surface the count so the user reassigns first.
  // (Role slugs are per-store, so the count MUST be store-scoped.)
  const countRows = await withService((db) =>
    db
      .select({ n: count() })
      .from(admins)
      .where(and(eq(admins.storeId, storeId), eq(admins.role, role.slug))),
  ).catch(() => [{ n: 0 }]);
  const holders = countRows[0]?.n ?? 0;

  if (holders > 0) {
    return {
      error: `${holders} admin${holders === 1 ? "" : "s"} still hold${holders === 1 ? "s" : ""} this role. Reassign them before deleting.`,
    };
  }

  try {
    await withService((db) =>
      db.delete(roles).where(and(eq(roles.id, id), eq(roles.storeId, storeId))),
    );
  } catch (err) {
    console.error("deleteRole error:", err);
    return { error: dbErrorMessage(err, "Failed to delete role.") };
  }

  revalidatePath("/dashboard/roles");
  revalidatePath("/dashboard/admins");
  return { success: true };
}
