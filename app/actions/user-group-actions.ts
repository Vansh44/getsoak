"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService, type UserIdentity } from "@/lib/db/client";
import { isUniqueViolation, dbErrorMessage } from "@/lib/db/errors";
import { userGroupMembers, userGroups } from "@/drizzle/schema";
import {
  getManagerIdentity,
  getActingStoreId,
} from "@/app/dashboard/lib/access";
import { storeAllowsPlanFeature } from "@/lib/plans/entitlements";

async function groupsPlanError(storeId: string): Promise<string | null> {
  return (await storeAllowsPlanFeature(storeId, "customerGroups"))
    ? null
    : "Customer groups are available on Basic and Pro. Your existing groups and memberships remain safe until you upgrade.";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroupFormData {
  name: string;
  description: string;
  color: string;
}

export interface ActionResult {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// User Groups live under the Users section, so they share its `manage` right.
async function getAdminIdentity(): Promise<UserIdentity | null> {
  return getManagerIdentity("users");
}

function revalidateGroups() {
  revalidatePath("/dashboard/users/user_groups");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createUserGroup(
  form: GroupFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  const storeId = await getActingStoreId();
  const planError = await groupsPlanError(storeId);
  if (planError) return { error: planError };

  const name = form.name.trim();
  if (!name) return { error: "Group name is required." };

  let inserted: Record<string, unknown>;
  try {
    const [row] = await withService((db) =>
      db
        .insert(userGroups)
        .values({
          name,
          description: form.description.trim() || null,
          color: form.color || "blue",
          createdBy: userId,
          storeId,
        })
        .returning(),
    );
    inserted = row as Record<string, unknown>;
  } catch (err) {
    if (isUniqueViolation(err))
      return { error: "A group with that name already exists." };
    console.error("createUserGroup error:", err);
    return { error: dbErrorMessage(err, "Failed to create group.") };
  }

  revalidateGroups();
  return { success: true, data: inserted };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateUserGroup(
  id: string,
  form: GroupFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };

  const name = form.name.trim();
  if (!name) return { error: "Group name is required." };

  // Scope by store_id (the service scope bypasses RLS) so a group can only be
  // edited by an admin of the store that owns it.
  const storeId = await getActingStoreId();
  const planError = await groupsPlanError(storeId);
  if (planError) return { error: planError };
  try {
    await withService((db) =>
      db
        .update(userGroups)
        .set({
          name,
          description: form.description.trim() || null,
          color: form.color || "blue",
        })
        .where(and(eq(userGroups.id, id), eq(userGroups.storeId, storeId))),
    );
  } catch (err) {
    if (isUniqueViolation(err))
      return { error: "A group with that name already exists." };
    console.error("updateUserGroup error:", err);
    return { error: dbErrorMessage(err, "Failed to update group.") };
  }

  revalidateGroups();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Delete (member rows + any coupon links cascade via FK ON DELETE CASCADE)
// ---------------------------------------------------------------------------

export async function deleteUserGroup(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };

  const storeId = await getActingStoreId();
  const planError = await groupsPlanError(storeId);
  if (planError) return { error: planError };
  try {
    await withService((db) =>
      db
        .delete(userGroups)
        .where(and(eq(userGroups.id, id), eq(userGroups.storeId, storeId))),
    );
  } catch (err) {
    console.error("deleteUserGroup error:", err);
    return { error: dbErrorMessage(err, "Failed to delete group.") };
  }

  revalidateGroups();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Membership — replace the group's whole membership with `customerIds`.
// Wholesale delete + insert keeps the dialog's checkbox state authoritative.
// ---------------------------------------------------------------------------

export async function setGroupMembers(
  groupId: string,
  customerIds: string[],
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  const storeId = await getActingStoreId();
  const planError = await groupsPlanError(storeId);
  if (planError) return { error: planError };

  // De-dupe defensively; an empty selection just clears the group.
  const ids = Array.from(new Set(customerIds.filter(Boolean)));

  try {
    await withService(async (db) => {
      // Verify the group belongs to this store before rewriting its membership
      // — otherwise a store admin could target another store's group by id.
      const groupRows = await db
        .select({ id: userGroups.id })
        .from(userGroups)
        .where(and(eq(userGroups.id, groupId), eq(userGroups.storeId, storeId)))
        .limit(1);
      if (!groupRows[0]) throw new Error("GROUP_NOT_FOUND");

      // Clear + insert in one transaction so membership is never left partial.
      await db
        .delete(userGroupMembers)
        .where(
          and(
            eq(userGroupMembers.groupId, groupId),
            eq(userGroupMembers.storeId, storeId),
          ),
        );

      if (ids.length > 0) {
        await db.insert(userGroupMembers).values(
          ids.map((memberId) => ({
            groupId,
            userId: memberId,
            addedBy: userId,
            storeId,
          })),
        );
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === "GROUP_NOT_FOUND") {
      return { error: "Group not found." };
    }
    console.error("setGroupMembers error:", err);
    return { error: dbErrorMessage(err, "Failed to update members.") };
  }

  revalidateGroups();
  return { success: true };
}
