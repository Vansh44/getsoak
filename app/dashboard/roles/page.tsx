import { asc, desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { admins, roles as rolesTable } from "@/drizzle/schema";
import {
  requireSectionAccess,
  getActingStoreId,
  type Role,
} from "../lib/access";
import { normalizePermissions } from "../lib/permissions";
import { RolesManagementView } from "./roles-management-view";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export default async function RolesPage() {
  const access = await requireSectionAccess("roles", "view");
  const canManage = access.can("roles", "manage");
  const storeId = await getActingStoreId();
  const { limits } = await getStorePlanContext(storeId);

  let rolesRaw: Record<string, unknown>[];
  let profiles: { role: string }[];
  try {
    ({ rolesRaw, profiles } = await withService(async (db) => {
      const rolesRaw = await db
        .select()
        .from(rolesTable)
        .where(eq(rolesTable.storeId, storeId))
        .orderBy(desc(rolesTable.isSystem), asc(rolesTable.name));
      // Count how many admins hold each role (by slug).
      const profiles = await db
        .select({ role: admins.role })
        .from(admins)
        .where(eq(admins.storeId, storeId));
      return {
        rolesRaw: rolesRaw as Record<string, unknown>[],
        profiles,
      };
    }));
  } catch (err) {
    console.error("Failed to load roles:", err);
    return (
      <div className="max-w-md border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span>⚠️</span> Failed to load roles
        </div>
        <p className="leading-relaxed text-destructive/80">
          Could not load the roles. Please try again.
        </p>
      </div>
    );
  }

  const counts = new Map<string, number>();
  for (const p of profiles) {
    if (p.role) counts.set(p.role, (counts.get(p.role) ?? 0) + 1);
  }

  const roles: (Role & { member_count: number })[] = rolesRaw.map((r) => ({
    ...(r as unknown as Role),
    permissions: normalizePermissions((r as unknown as Role).permissions),
    member_count: counts.get((r as unknown as Role).slug) ?? 0,
  }));

  return (
    <RolesManagementView
      roles={roles}
      canManage={canManage}
      planLocked={!limits.customRoles}
    />
  );
}
