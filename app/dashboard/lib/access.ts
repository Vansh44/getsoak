import { cache } from "react";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { withService, type UserIdentity } from "@/lib/db/client";
import { admins, platformAdmins, roles } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";
import {
  can,
  normalizePermissions,
  SUPERADMIN_SLUG,
  type PermissionAction,
  type RolePermissions,
} from "./permissions";

export interface ViewerProfile {
  email: string;
  role: string | null;
  first_name: string | null;
  last_name: string | null;
  store_id: string;
}

export interface ViewerContext {
  userId: string;
  userEmail: string | null;
  profile: ViewerProfile | null;
  isSuperadmin: boolean;
  permissions: RolePermissions;
  /** The store this dashboard is operating on (resolved from the host). */
  storeId: string;
  /** True when the viewer is a Storemink platform operator (god access). */
  isPlatformAdmin: boolean;
  /**
   * The access lookups themselves FAILED (database unreachable) — we don't know
   * what this user may do, which is NOT the same as knowing they may do nothing.
   * `profile` is null in both cases, so callers that render an access decision
   * (the dashboard layout) MUST check this first and show an outage, never
   * "no access". See the note on getViewerContext.
   */
  dbError?: boolean;
}

// Platform-operator role for the signed-in user (by JWT email), or null.
// Request-cached so multiple gates don't re-query.
const getPlatformRole = cache(
  async (): Promise<"superadmin" | "member" | null> => {
    const user = await getServerUser();
    if (!user?.email) return null;
    // Exact (case-normalised) match — NEVER ILIKE on the user's own email:
    // that treats `_`/`%` in a registered address as SQL wildcards, so an email
    // like `admin0_@x.com` could match a real operator and escalate to platform
    // god access. Operator emails are always stored lowercased (invitePlatformAdmin
    // + seed), mirroring the DB's `lower(email)` RLS helpers. platform_admins IS
    // the allowlist, so a service-scope read filtered by the verified email is
    // the gate.
    // A query failure is NOT "not an operator" — it propagates (see
    // getViewerContext). Swallowing it here would silently downgrade a platform
    // operator to a stranger the moment the DB hiccups.
    const rows = await withService((db) =>
      db
        .select({ role: platformAdmins.role })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, user.email!.toLowerCase()))
        .limit(1),
    );
    return (rows[0]?.role as "superadmin" | "member" | undefined) ?? null;
  },
);

/**
 * Resolve the signed-in admin for the CURRENT (host) store + their permissions.
 * Request-cached (React cache) so the layout and page share one resolution.
 *
 * Access model:
 *  • A store admin has an `admins` row for the host store → their role applies.
 *  • A platform operator (platform_admins) is an implicit superadmin of EVERY
 *    store, so they get full access even without a store-admin row.
 *  • Anyone else → profile: null (the layout shows a setup screen).
 * Returns null only when there is no session.
 *
 * A DB FAILURE IS NOT AN ACCESS DECISION. These lookups used to be wrapped in
 * `.catch(() => [])`, which made an unreachable database look exactly like "this
 * account is not staff of this store" — the layout then accused a legitimate
 * owner of not owning their store (it happened on 2026-07-22, when the local
 * Cloud SQL proxy lost its ADC token, and cost an hour of chasing a phantom
 * permissions bug). Same rule lib/store/resolve.ts already follows for store
 * lookups. So the error is caught ONLY to label it: `dbError: true` with no
 * permissions, which the layout renders as an outage. The gates below
 * (getManagerUserId) don't catch at all — they let it throw, because a server
 * action returning "not authorized" for a network blip is the same lie.
 */
export const getViewerContext = cache(
  async (): Promise<ViewerContext | null> => {
    const user = await getServerUser();
    if (!user) return null;

    const storeId = await getCurrentStoreId();

    const base = {
      userId: user.id,
      userEmail: user.email ?? null,
      storeId,
    };

    let isPlatformAdmin = false;
    let profile: ViewerProfile | undefined;
    try {
      isPlatformAdmin = (await getPlatformRole()) !== null;

      // The user's admin row for THIS store (if they're store staff here).
      // Service scope + the verified user id + store id are the scoping.
      const profileRows = await withService((db) =>
        db
          .select({
            email: admins.email,
            role: admins.role,
            first_name: admins.firstName,
            last_name: admins.lastName,
            store_id: admins.storeId,
          })
          .from(admins)
          .where(and(eq(admins.id, user.id), eq(admins.storeId, storeId)))
          .limit(1),
      );
      profile = profileRows[0];
    } catch (error) {
      logError("dashboard: access lookup failed", error, {
        userId: user.id,
        storeId,
      });
      return {
        ...base,
        isPlatformAdmin: false,
        profile: null,
        isSuperadmin: false,
        permissions: {},
        dbError: true,
      };
    }

    if (!profile) {
      // Platform operator dropping into a store they have no row for → treat as
      // its superadmin. Everyone else → no profile (setup screen).
      if (isPlatformAdmin) {
        return {
          ...base,
          isPlatformAdmin,
          profile: {
            email: user.email ?? "",
            role: SUPERADMIN_SLUG,
            first_name: null,
            last_name: null,
            store_id: storeId,
          },
          isSuperadmin: true,
          permissions: {},
        };
      }
      return {
        ...base,
        isPlatformAdmin,
        profile: null,
        isSuperadmin: false,
        permissions: {},
      };
    }

    const roleSlug: string = profile.role ?? "";
    const isSuperadmin = roleSlug === SUPERADMIN_SLUG || isPlatformAdmin;

    let permissions: RolePermissions = {};
    if (!isSuperadmin && roleSlug) {
      // Same rule as above: an unreadable roles table means we don't KNOW this
      // admin's permissions. Defaulting to {} would strip a staff member down to
      // an empty dashboard and blame their role for it.
      try {
        const roleRows = await withService((db) =>
          db
            .select({ permissions: roles.permissions })
            .from(roles)
            .where(and(eq(roles.storeId, storeId), eq(roles.slug, roleSlug)))
            .limit(1),
        );
        permissions = normalizePermissions(roleRows[0]?.permissions);
      } catch (error) {
        logError("dashboard: role permissions lookup failed", error, {
          userId: user.id,
          storeId,
          roleSlug,
        });
        return {
          ...base,
          isPlatformAdmin,
          profile: null,
          isSuperadmin: false,
          permissions: {},
          dbError: true,
        };
      }
    }

    return { ...base, isPlatformAdmin, profile, isSuperadmin, permissions };
  },
);

/**
 * The store the dashboard is operating on — resolved from the request host.
 * For a store admin this is their store; for a platform operator it's whichever
 * store's dashboard they're currently on. Used as `store_id` on dashboard writes.
 */
export async function getActingStoreId(): Promise<string> {
  return getCurrentStoreId();
}

export interface Role {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  permissions: RolePermissions;
  color: string;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface ViewerAccess {
  userId: string;
  email: string;
  roleSlug: string;
  isSuperadmin: boolean;
  permissions: RolePermissions;
  can: (section: string, action: PermissionAction) => boolean;
}

/**
 * Resolve the signed-in admin and the permission set they have on the current
 * store. Redirects to login when there is no session. Returns null when the
 * user is authenticated but has no access here (the layout renders a setup
 * screen for that case).
 */
export async function getViewerAccess(): Promise<ViewerAccess | null> {
  const ctx = await getViewerContext();

  if (!ctx) {
    redirect("/auth/login");
  }

  if (!ctx.profile) return null;

  const roleSlug: string = ctx.profile.role ?? "";

  return {
    userId: ctx.userId,
    email: ctx.profile.email,
    roleSlug,
    isSuperadmin: ctx.isSuperadmin,
    permissions: ctx.permissions,
    can: (section, action) =>
      can(ctx.permissions, section, action, ctx.isSuperadmin),
  };
}

/**
 * Server-action gate (non-redirecting). Returns the caller's verified IDENTITY
 * (uid + email) only if they may `manage` `section` on the current store, else
 * null. Platform operators and store superadmins always pass.
 *
 * Returns the identity rather than a bare uid because that is exactly what
 * `withUser` needs: the email feeds `auth.email()`, which is how the RLS
 * helpers recognise a platform operator (`is_platform_admin()` matches
 * `platform_admins` BY EMAIL). A user-scoped query opened with the uid alone
 * silently sees nothing on a store the caller isn't staff of — see the note on
 * `withUser` in lib/db/client.ts.
 *
 * `null` means DENIED and nothing else. A failed lookup THROWS (these queries
 * are deliberately un-caught) so the action surfaces a real error instead of
 * telling a legitimate admin they aren't authorised — see getViewerContext.
 */
export async function getManagerIdentity(
  section: string,
): Promise<UserIdentity | null> {
  const user = await getServerUser();
  if (!user) return null;

  const identity: UserIdentity = { uid: user.id, email: user.email ?? null };

  // Platform operators manage everything.
  if ((await getPlatformRole()) !== null) return identity;

  const storeId = await getCurrentStoreId();
  const profileRows = await withService((db) =>
    db
      .select({ role: admins.role })
      .from(admins)
      .where(and(eq(admins.id, user.id), eq(admins.storeId, storeId)))
      .limit(1),
  );

  const slug = profileRows[0]?.role;
  if (!slug) return null;
  if (slug === SUPERADMIN_SLUG) return identity;

  const roleRows = await withService((db) =>
    db
      .select({ permissions: roles.permissions })
      .from(roles)
      .where(and(eq(roles.storeId, storeId), eq(roles.slug, slug)))
      .limit(1),
  );

  // Role found: enforce the permission map.
  if (roleRows[0]) {
    const perms = normalizePermissions(roleRows[0].permissions);
    return can(perms, section, "manage") ? identity : null;
  }

  // Legacy fallback before the roles table is populated: "member" keeps rights.
  if (slug === "member") return identity;
  return null;
}

/**
 * Is the signed-in user a SUPERADMIN of the current store? Platform operators
 * count — they are implicit superadmins of every store (`is_platform_admin()`).
 *
 * This is a narrower question than `getManagerIdentity(section)`, which a
 * delegated admin also passes. Ask it only where a capability must not be
 * delegable at all: today the POS money-losing actions (discounts and price
 * overrides — CODEBASE §22). Reads the request-cached viewer context, so on a
 * page that already resolved it this costs nothing.
 *
 * FAILS CLOSED, unlike the gates above: `getViewerContext` labels a DB error
 * rather than throwing, so an outage answers "not a superadmin". That is the
 * right side to err on here — the consequence is a refused discount, not a
 * locked-out admin, and the write it guards couldn't have succeeded anyway.
 */
export async function isStoreSuperadmin(): Promise<boolean> {
  const ctx = await getViewerContext();
  return !!ctx?.isSuperadmin;
}

/**
 * The same gate, when the caller only needs the id (an auth check, a
 * `created_by`/`updated_by` value) and never opens a user-scoped transaction.
 * If you are about to call `withUser`, use `getManagerIdentity` instead — its
 * required `email` is what keeps the platform-operator RLS branch alive.
 */
export async function getManagerUserId(
  section: string,
): Promise<string | null> {
  return (await getManagerIdentity(section))?.uid ?? null;
}

/**
 * Page guard: ensure the viewer can `view` (or `manage`) a section, else send
 * them back to the dashboard home. Returns the resolved access for reuse.
 */
export async function requireSectionAccess(
  section: string,
  action: PermissionAction = "view",
): Promise<ViewerAccess> {
  const access = await getViewerAccess();
  // No profile -> let the layout's setup screen handle it; bounce to /dashboard.
  if (!access) redirect("/dashboard");
  if (!access.can(section, action)) {
    redirect("/dashboard?denied=" + encodeURIComponent(section));
  }
  return access;
}
