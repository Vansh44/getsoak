"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getPlatformViewer } from "@/app/actions/platform";
import { minkStoreAccess, stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";

export async function setMinkBetaAccess(
  storeId: string,
  enabled: boolean,
): Promise<{ success?: true; error?: string }> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change Mink beta access." };
  }
  if (typeof enabled !== "boolean") return { error: "Invalid beta state." };
  try {
    const changed = await withService(async (db) => {
      const store = await db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      if (!store[0]) return false;
      const now = new Date().toISOString();
      await db
        .insert(minkStoreAccess)
        .values({
          storeId,
          enabled,
          phase: "merchant_beta",
          invitedBy: enabled ? viewer.email : null,
          invitedAt: enabled ? now : null,
        })
        .onConflictDoUpdate({
          target: minkStoreAccess.storeId,
          set: {
            enabled,
            ...(!enabled ? { draftingEnabled: false } : {}),
            phase: "merchant_beta",
            invitedBy: enabled ? viewer.email : null,
            invitedAt: enabled ? now : null,
            updatedAt: now,
          },
        });
      return true;
    });
    if (!changed) return { error: "Store not found." };
    revalidatePath(`/dashboard/stores/${storeId}`);
    revalidatePath("/dashboard/mink");
    logInfo("mink.beta_access: changed", {
      storeId,
      enabled,
      operator: viewer.email,
    });
    return { success: true };
  } catch (error) {
    logError("mink.beta_access: failed", error, { storeId, enabled });
    return { error: "Could not change Mink beta access. Try again." };
  }
}

export async function setMinkDraftingAccess(
  storeId: string,
  enabled: boolean,
): Promise<{ success?: true; error?: string }> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return {
      error: "Only a platform superadmin can change Mink drafting access.",
    };
  }
  if (typeof enabled !== "boolean") return { error: "Invalid drafting state." };
  try {
    const changed = await withService((db) =>
      db
        .update(minkStoreAccess)
        .set({ draftingEnabled: enabled, updatedAt: new Date().toISOString() })
        .where(
          enabled
            ? and(
                eq(minkStoreAccess.storeId, storeId),
                eq(minkStoreAccess.enabled, true),
              )
            : eq(minkStoreAccess.storeId, storeId),
        )
        .returning({ storeId: minkStoreAccess.storeId }),
    );
    if (!changed[0]) {
      return {
        error: enabled
          ? "Invite the store to the Mink beta before enabling drafting."
          : "This store does not have a Mink access record.",
      };
    }
    revalidatePath(`/dashboard/stores/${storeId}`);
    revalidatePath("/dashboard/mink");
    logInfo("mink.drafting_access: changed", {
      storeId,
      enabled,
      operator: viewer.email,
    });
    return { success: true };
  } catch (error) {
    logError("mink.drafting_access: failed", error, { storeId, enabled });
    return { error: "Could not change Mink drafting access. Try again." };
  }
}
