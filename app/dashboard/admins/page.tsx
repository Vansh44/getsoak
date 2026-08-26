import { asc, desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins, roles } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { UsersManagementView } from "./users-management-view";
import { getStoreLocations } from "@/lib/pos/locations";
import { listAdminLocations } from "@/app/actions/location-actions";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export interface RoleOption {
  slug: string;
  name: string;
  color: string;
}

export interface Profile {
  id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  role: string;
  force_password_reset: boolean;
  is_suspended: boolean;
  created_at: string;
}

export default async function UsersPage() {
  const access = await requireSectionAccess("admins", "view");
  const canManage = access.can("admins", "manage");
  const storeId = await getActingStoreId();
  const planContext = await getStorePlanContext(storeId);

  // The admins (staff) table is RLS-scoped to own-row reads, so cross-row
  // listing goes through the service scope with an explicit store filter —
  // same pattern as the Users (customers) list. The page is already gated by
  // requireSectionAccess("admins", "view") above.
  let profiles: Profile[];
  let rolesData: RoleOption[];
  try {
    ({ profiles, rolesData } = await withService(async (db) => {
      const profiles = await db
        .select({
          id: admins.id,
          email: admins.email,
          first_name: admins.firstName,
          last_name: admins.lastName,
          role: admins.role,
          force_password_reset: admins.forcePasswordReset,
          is_suspended: admins.isSuspended,
          created_at: admins.createdAt,
        })
        .from(admins)
        .where(eq(admins.storeId, storeId))
        .orderBy(desc(admins.createdAt));
      const rolesData = await db
        .select({
          slug: roles.slug,
          name: roles.name,
          color: roles.color,
        })
        .from(roles)
        .where(eq(roles.storeId, storeId))
        .orderBy(desc(roles.isSystem), asc(roles.name));
      return {
        profiles: profiles as Profile[],
        rolesData: rolesData as RoleOption[],
      };
    }));
  } catch (err) {
    console.error("Failed to load admins:", err);
    return (
      <div className="max-w-md border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span>⚠️</span> Failed to load users
        </div>
        <p className="leading-relaxed text-destructive/80">
          Make sure you have superadmin access and the admins table exists in
          your database.
        </p>
      </div>
    );
  }

  // Fall back to the two built-in roles if the roles table isn't seeded yet.
  const roleOptions: RoleOption[] =
    rolesData.length > 0
      ? rolesData
      : [
          { slug: "superadmin", name: "Superadmin", color: "violet" },
          { slug: "member", name: "Member", color: "blue" },
        ];

  // Only meaningful for a multi-shop store — the invite dialog hides the field
  // entirely below two, because a scope picker with one option is a decision
  // nobody has to make.
  const locations = await getStoreLocations(storeId).catch(() => []);
  // Who is currently restricted to what, so the editor opens on today's answer
  // rather than resetting anyone to unrestricted on save.
  const { bindings } = await listAdminLocations();

  return (
    <UsersManagementView
      currentUserId={access.userId}
      profiles={profiles}
      roleOptions={roleOptions}
      canManage={canManage}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      bindings={bindings}
      canInvite={
        canManage &&
        (planContext.limits.maxStaff === null ||
          profiles.length < planContext.limits.maxStaff)
      }
      staffLimit={planContext.limits.maxStaff}
    />
  );
}
