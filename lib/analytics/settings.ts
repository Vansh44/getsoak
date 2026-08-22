import "server-only";

import { eq } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { normalizeAnalyticsTimeZone } from "./range";

export async function getStoreAnalyticsTimeZone(
  storeId: string,
): Promise<string> {
  const [store] = await withService((db) =>
    db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  const settings =
    (store?.settings as Record<string, unknown> | undefined) ?? {};
  const business =
    settings.business && typeof settings.business === "object"
      ? (settings.business as Record<string, unknown>)
      : {};
  return normalizeAnalyticsTimeZone(business.timeZone);
}
