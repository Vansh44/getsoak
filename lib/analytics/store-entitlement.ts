import "server-only";

import { eq } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { effectivePlan } from "@/lib/plans";
import { analyticsFeatureAllowed, type AnalyticsFeatureId } from "./features";
import { getPlatformAnalyticsFeatures } from "./platform-feature-store";

/** Resolve both halves of an Analytics entitlement: platform switch + plan. */
export async function storeHasAnalyticsFeature(
  storeId: string,
  feature: AnalyticsFeatureId,
): Promise<boolean> {
  const [[store], platform] = await Promise.all([
    withService((db) =>
      db
        .select({ plan: stores.plan, expiresAt: stores.planExpiresAt })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    ),
    getPlatformAnalyticsFeatures(),
  ]);
  if (!store) return false;
  const plan = effectivePlan({
    plan: store.plan,
    plan_expires_at: store.expiresAt,
  });
  return analyticsFeatureAllowed(platform, feature, plan);
}
