"use server";

import { eq } from "drizzle-orm";
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
