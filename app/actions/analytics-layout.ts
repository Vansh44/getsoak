"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { WIDGETS, type WidgetId } from "@/app/dashboard/analytics/widgets";
import { analyticsDashboardLayouts } from "@/drizzle/schema";
import {
  ANALYTICS_LAYOUT_SCHEMA_VERSION,
  sanitizeStoredAnalyticsLayout,
  sanitizeWidgetIds,
  storedAnalyticsLayout,
} from "@/lib/analytics/layout";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { getViewerLocations } from "@/lib/locations/scope";

export interface AnalyticsLayoutActionResult {
  success?: boolean;
  error?: string;
  conflict?: boolean;
  updatedAt?: string | null;
}

async function actionContext() {
  const viewer = await getViewerContext();
  if (!viewer || viewer.dbError || !viewer.profile) return null;
  if (!can(viewer.permissions, "analytics", "view", viewer.isSuperadmin)) {
    return null;
  }
  const scope = await getViewerLocations();
  const allowed = new Set<WidgetId>(Object.keys(WIDGETS) as WidgetId[]);
  if (scope !== null) allowed.delete("metric_customers");
  if (!can(viewer.permissions, "blogs", "view", viewer.isSuperadmin)) {
    allowed.delete("blog_approvals");
  }
  if (!can(viewer.permissions, "enquiries", "view", viewer.isSuperadmin)) {
    allowed.delete("enquiries");
  }
  return { viewer, allowed };
}

function sameVersion(
  expectedUpdatedAt: string | null,
  actualUpdatedAt: string | null,
) {
  return expectedUpdatedAt === actualUpdatedAt;
}

function conflict(): AnalyticsLayoutActionResult {
  return {
    error:
      "This dashboard changed in another tab or device. Reload before saving again.",
    conflict: true,
  };
}

async function lockLayout(
  db: Parameters<Parameters<typeof withService>[0]>[0],
  storeId: string,
  userId: string,
) {
  // FOR UPDATE cannot lock a row that does not exist. The per-key advisory
  // lock also serializes two first-time saves, so the second request observes
  // the row and fails its expectedUpdatedAt=null check instead of upserting
  // over the first writer.
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${storeId}:${userId}`}, 0))`,
  );
}

export async function saveAnalyticsDashboardLayout(
  rawWidgetIds: unknown,
  expectedUpdatedAt: string | null,
): Promise<AnalyticsLayoutActionResult> {
  const ctx = await actionContext();
  if (!ctx) return { error: "You don't have access to Analytics." };

  const requested = sanitizeWidgetIds(rawWidgetIds);
  if (!requested || requested.some((id) => !ctx.allowed.has(id))) {
    return { error: "That dashboard layout isn't valid for this account." };
  }

  const updatedAt = new Date().toISOString();
  try {
    const result = await withService(async (db) => {
      await lockLayout(db, ctx.viewer.storeId, ctx.viewer.userId);
      const [existing] = await db
        .select({
          layout: analyticsDashboardLayouts.layout,
          updatedAt: analyticsDashboardLayouts.updatedAt,
        })
        .from(analyticsDashboardLayouts)
        .where(
          and(
            eq(analyticsDashboardLayouts.storeId, ctx.viewer.storeId),
            eq(analyticsDashboardLayouts.adminUserId, ctx.viewer.userId),
          ),
        )
        .limit(1)
        .for("update");

      if (!sameVersion(expectedUpdatedAt, existing?.updatedAt ?? null)) {
        return conflict();
      }

      // Preserve saved cards that are temporarily unavailable to this viewer.
      // Their preference must survive a location/permission change, but they
      // remain omitted from both rendering and submitted client input.
      const old = sanitizeStoredAnalyticsLayout(existing?.layout);
      const dormant = old?.widgetIds.filter((id) => !ctx.allowed.has(id)) ?? [];
      const widgetIds = [...requested, ...dormant];

      await db
        .insert(analyticsDashboardLayouts)
        .values({
          storeId: ctx.viewer.storeId,
          adminUserId: ctx.viewer.userId,
          schemaVersion: ANALYTICS_LAYOUT_SCHEMA_VERSION,
          layout: storedAnalyticsLayout(widgetIds),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [
            analyticsDashboardLayouts.storeId,
            analyticsDashboardLayouts.adminUserId,
          ],
          set: {
            schemaVersion: ANALYTICS_LAYOUT_SCHEMA_VERSION,
            layout: storedAnalyticsLayout(widgetIds),
            updatedAt,
          },
        });
      return { success: true, updatedAt } satisfies AnalyticsLayoutActionResult;
    });
    if (result.success) revalidatePath("/dashboard/analytics");
    return result;
  } catch (error) {
    if (isUniqueViolation(error)) return conflict();
    console.error("saveAnalyticsDashboardLayout:", error);
    return { error: "Couldn't save the dashboard. Please try again." };
  }
}

export async function resetAnalyticsDashboardLayout(
  expectedUpdatedAt: string | null,
): Promise<AnalyticsLayoutActionResult> {
  const ctx = await actionContext();
  if (!ctx) return { error: "You don't have access to Analytics." };

  try {
    const result = await withService(async (db) => {
      await lockLayout(db, ctx.viewer.storeId, ctx.viewer.userId);
      const [existing] = await db
        .select({ updatedAt: analyticsDashboardLayouts.updatedAt })
        .from(analyticsDashboardLayouts)
        .where(
          and(
            eq(analyticsDashboardLayouts.storeId, ctx.viewer.storeId),
            eq(analyticsDashboardLayouts.adminUserId, ctx.viewer.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!sameVersion(expectedUpdatedAt, existing?.updatedAt ?? null)) {
        return conflict();
      }
      if (existing) {
        await db
          .delete(analyticsDashboardLayouts)
          .where(
            and(
              eq(analyticsDashboardLayouts.storeId, ctx.viewer.storeId),
              eq(analyticsDashboardLayouts.adminUserId, ctx.viewer.userId),
            ),
          );
      }
      return {
        success: true,
        updatedAt: null,
      } satisfies AnalyticsLayoutActionResult;
    });
    if (result.success) revalidatePath("/dashboard/analytics");
    return result;
  } catch (error) {
    console.error("resetAnalyticsDashboardLayout:", error);
    return { error: "Couldn't reset the dashboard. Please try again." };
  }
}
