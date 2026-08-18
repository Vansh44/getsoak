"use server";

import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { stores } from "@/drizzle/schema";
import { isValidTimeZone } from "@/lib/analytics/range";
import { withService } from "@/lib/db/client";
import { STORE_TAG } from "@/lib/store/resolve";

export interface AnalyticsSettingsState {
  success?: string;
  error?: string;
}

export async function saveAnalyticsTimeZone(
  _previous: AnalyticsSettingsState,
  formData: FormData,
): Promise<AnalyticsSettingsState> {
  const viewer = await getViewerContext();
  if (viewer?.dbError)
    return { error: "Couldn't reach the database. Try again." };
  if (!viewer?.profile) return { error: "Not authenticated." };
  if (!can(viewer.permissions, "settings", "manage", viewer.isSuperadmin)) {
    return { error: "You don't have permission to change store settings." };
  }

  const timeZone = formData.get("timeZone");
  if (!isValidTimeZone(timeZone)) {
    return { error: "Choose a valid business time zone." };
  }

  try {
    await withService(async (db) => {
      const [store] = await db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, viewer.storeId))
        .limit(1);
      const settings =
        (store?.settings as Record<string, unknown> | undefined) ?? {};
      const business =
        settings.business && typeof settings.business === "object"
          ? (settings.business as Record<string, unknown>)
          : {};
      await db
        .update(stores)
        .set({
          settings: {
            ...settings,
            business: { ...business, timeZone },
          },
        })
        .where(eq(stores.id, viewer.storeId));
    });
  } catch (error) {
    console.error("saveAnalyticsTimeZone:", error);
    return { error: "Could not save the time zone. Please try again." };
  }

  updateTag(STORE_TAG);
  revalidatePath("/dashboard/analytics");
  revalidatePath("/dashboard/settings");
  return { success: "Business time zone saved." };
}
