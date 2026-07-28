import "server-only";

// ---------------------------------------------------------------------------
// Who hears about an event.
//
// Store-admin routing is DERIVED FROM THE PERMISSION MAP: an event declares the
// dashboard section it belongs to (events.ts `section`), and only admins who
// may `view` that section are notified. So a content editor never gets paged
// about payments, and there is no second recipient list to drift out of sync
// with roles — the same map that hides the sidebar link hides the notification.
//
// Every function here takes the caller's `db` so the whole fan-out runs inside
// ONE service-scoped transaction (see record.ts).
// ---------------------------------------------------------------------------

import { and, eq, ne, or, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  adminLocations,
  admins,
  platformAdmins,
  roles,
} from "@/drizzle/schema";
import {
  can,
  normalizePermissions,
  SUPERADMIN_SLUG,
} from "@/app/dashboard/lib/permissions";
import type { Audience } from "./events";

export interface Recipient {
  /** Firebase uid — except operators, who are keyed by lowercased email
   *  (platform_admins is an email allowlist with no uid). */
  id: string;
  type: "admin" | "customer" | "operator";
  audience: Audience;
  /** For the email channel; null when the account has no address. */
  email: string | null;
  label: string | null;
  /** Role slug, so a store's routing rule can target by role (routing.ts).
   *  Empty for customers and operators, who are never role-routed. */
  roleSlug: string;
  /** Locations this admin is restricted to, or null for unrestricted. Feeds
   *  the `event_location` routing scope. Absence is not restriction — an admin
   *  nobody has assigned hears about every location, exactly as before
   *  locations existed. */
  locationIds?: string[] | null;
}

/**
 * Staff of `storeId` who may `view` `section` — the recipients of a
 * store-admin event. Suspended admins are skipped: someone who can't sign in
 * shouldn't accrue an inbox.
 */
export async function storeAdminRecipients(
  db: Db,
  storeId: string,
  section: string,
): Promise<Recipient[]> {
  // Sequential, NOT Promise.all: both run on the caller's single pooled
  // connection, which can only serve one query at a time (see the same note in
  // order-actions.ts). Parallelising trips pg's "query while another is in
  // flight" path for zero gain.
  const staff = await db
    .select({
      id: admins.id,
      email: admins.email,
      role: admins.role,
      firstName: admins.firstName,
      lastName: admins.lastName,
    })
    .from(admins)
    .where(
      and(
        eq(admins.storeId, storeId),
        or(isNull(admins.isSuspended), eq(admins.isSuspended, false)),
      ),
    );
  const roleRows = await db
    .select({ slug: roles.slug, permissions: roles.permissions })
    .from(roles)
    .where(eq(roles.storeId, storeId));
  // Sequential for the same reason as above: one pooled connection.
  const locationRows = await db
    .select({
      admin_id: adminLocations.adminId,
      location_id: adminLocations.locationId,
    })
    .from(adminLocations)
    .where(eq(adminLocations.storeId, storeId));

  const locationsByAdmin = new Map<string, string[]>();
  for (const row of locationRows) {
    const list = locationsByAdmin.get(row.admin_id) ?? [];
    list.push(row.location_id);
    locationsByAdmin.set(row.admin_id, list);
  }

  const permsBySlug = new Map(
    roleRows.map((r) => [r.slug, normalizePermissions(r.permissions)]),
  );

  const out: Recipient[] = [];
  for (const admin of staff) {
    const slug = admin.role ?? "";
    const isSuperadmin = slug === SUPERADMIN_SLUG;
    if (!isSuperadmin) {
      const perms = permsBySlug.get(slug);
      // Legacy stores predate the roles table: a bare "member" keeps access,
      // mirroring the same fallback in getManagerIdentity.
      if (perms ? !can(perms, section, "view") : slug !== "member") continue;
    }
    out.push({
      id: admin.id,
      type: "admin",
      audience: "store-admins",
      email: admin.email,
      roleSlug: slug,
      // A superadmin is never location-bound (docs/locations-ia.md §6).
      locationIds: isSuperadmin
        ? null
        : (locationsByAdmin.get(admin.id) ?? null),
      label:
        [admin.firstName, admin.lastName].filter(Boolean).join(" ") || null,
    });
  }
  return out;
}

/**
 * StoreMink platform operators. Keyed by lowercased email — see the note on
 * the notifications RLS policy in supabase/notifications_01_schema.sql.
 */
export async function operatorRecipients(db: Db): Promise<Recipient[]> {
  const rows = await db
    .select({ email: platformAdmins.email })
    .from(platformAdmins)
    .where(ne(platformAdmins.email, ""));

  return rows.map((r) => {
    const email = r.email.toLowerCase();
    return {
      id: email,
      type: "operator" as const,
      audience: "operators" as const,
      email,
      roleSlug: "",
      label: null,
    };
  });
}
