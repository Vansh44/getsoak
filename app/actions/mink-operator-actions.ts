"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getPlatformViewer } from "@/app/actions/platform";
import {
  minkActionToolAccess,
  minkStoreAccess,
  stores,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  isMinkProductActionTool,
  type MinkProductActionTool,
} from "@/lib/mink/product-action-types";
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
      if (!enabled) {
        await db
          .update(minkActionToolAccess)
          .set({ enabled: false, updatedAt: now })
          .where(eq(minkActionToolAccess.storeId, storeId));
      }
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
    const changed = await withService(async (db) => {
      // Serialize every child action gate with the parent access row. Without
      // this lock, an enable racing a drafting shutdown could commit last and
      // leave a misleading enabled child row (execution would still fail, but
      // the operator console would lie about the kill-switch state).
      await db.execute(sql`
        select store_id from public.mink_store_access
        where store_id = ${storeId}::uuid
        for update
      `);
      const rows = await db
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
        .returning({ storeId: minkStoreAccess.storeId });
      if (!enabled && rows[0]) {
        await db
          .update(minkActionToolAccess)
          .set({ enabled: false, updatedAt: new Date().toISOString() })
          .where(eq(minkActionToolAccess.storeId, storeId));
      }
      return rows;
    });
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

export async function setMinkActionToolAccess(
  storeId: string,
  toolName: MinkProductActionTool,
  enabled: boolean,
): Promise<{ success?: true; error?: string }> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return {
      error: "Only a platform superadmin can change Mink action access.",
    };
  }
  if (!isMinkProductActionTool(toolName) || typeof enabled !== "boolean") {
    return { error: "Invalid Mink action state." };
  }
  try {
    const changed = await withService(async (db) => {
      await db.execute(sql`
        select store_id from public.mink_store_access
        where store_id = ${storeId}::uuid
        for update
      `);
      const rows = await db
        .select({
          enabled: minkStoreAccess.enabled,
          draftingEnabled: minkStoreAccess.draftingEnabled,
        })
        .from(minkStoreAccess)
        .where(eq(minkStoreAccess.storeId, storeId))
        .limit(1);
      if (!rows[0]) return "missing" as const;
      if (enabled && (!rows[0].enabled || !rows[0].draftingEnabled)) {
        return "prerequisite" as const;
      }
      const now = new Date().toISOString();
      await db
        .insert(minkActionToolAccess)
        .values({
          storeId,
          toolName,
          enabled,
          enabledBy: enabled ? viewer.email : null,
          enabledAt: enabled ? now : null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [minkActionToolAccess.storeId, minkActionToolAccess.toolName],
          set: {
            enabled,
            enabledBy: enabled ? viewer.email : null,
            enabledAt: enabled ? now : null,
            updatedAt: now,
          },
        });
      return "changed" as const;
    });
    if (changed === "missing") {
      return { error: "Invite the store to the Mink beta first." };
    }
    if (changed === "prerequisite") {
      return {
        error: "Enable the Mink beta and private drafting before live actions.",
      };
    }
    revalidatePath(`/dashboard/stores/${storeId}`);
    revalidatePath("/dashboard/mink");
    logInfo("mink.action_tool_access: changed", {
      storeId,
      toolName,
      enabled,
      operator: viewer.email,
    });
    return { success: true };
  } catch (error) {
    logError("mink.action_tool_access: failed", error, {
      storeId,
      toolName,
      enabled,
    });
    return { error: "Could not change Mink action access. Try again." };
  }
}
