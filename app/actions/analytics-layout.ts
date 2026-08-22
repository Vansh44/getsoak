"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { WIDGETS, type WidgetId } from "@/app/dashboard/analytics/widgets";
import { analyticsDashboardLayouts } from "@/drizzle/schema";
import {
  ANALYTICS_LAYOUT_SCHEMA_VERSION,
  MAX_ANALYTICS_SECTIONS,
  sanitizeAnalyticsLayoutInput,
  sanitizeStoredAnalyticsLayout,
  storedAnalyticsLayout,
  type AnalyticsLayoutSection,
} from "@/lib/analytics/layout";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { getViewerLocations } from "@/lib/locations/scope";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";

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
  const [scope, features] = await Promise.all([
    getViewerLocations(),
    getPlatformAnalyticsFeatures(),
  ]);
  if (!features.coreDashboard || !features.dashboardCustomization) return null;
  const allowed = new Set<WidgetId>(Object.keys(WIDGETS) as WidgetId[]);
  if (!features.googleSearchConsole) {
    for (const id of allowed) {
      if (WIDGETS[id].group === "Search") allowed.delete(id);
    }
  }
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
  rawLayout: unknown,
  expectedUpdatedAt: string | null,
): Promise<AnalyticsLayoutActionResult> {
  const ctx = await actionContext();
  if (!ctx) return { error: "You don't have access to Analytics." };

  const requested = sanitizeAnalyticsLayoutInput(rawLayout);
  const requestedIds =
    requested?.sections.flatMap((section) =>
      section.items.map((item) => item.widgetId),
    ) ?? [];
  if (!requested || requestedIds.some((id) => !ctx.allowed.has(id))) {
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
      const sections: AnalyticsLayoutSection[] = requested.sections.map(
        (section) => ({
          ...section,
          items: section.items.map((item) => ({ ...item })),
        }),
      );
      for (const oldSection of old?.sections ?? []) {
        const dormant = oldSection.items.filter(
          (item) => !ctx.allowed.has(item.widgetId),
        );
        if (dormant.length === 0) continue;
        const matching = sections.find(
          (section) => section.id === oldSection.id,
        );
        if (matching) {
          matching.items.push(...dormant);
        } else if (sections.length < MAX_ANALYTICS_SECTIONS) {
          sections.push({ ...oldSection, items: dormant });
        } else if (sections[0]) {
          // The submitted layout already used every section slot. Preserve the
          // inaccessible preferences in the first section rather than dropping
          // them; server filtering keeps them invisible until access returns.
          sections[0].items.push(...dormant);
        }
      }

      await db
        .insert(analyticsDashboardLayouts)
        .values({
          storeId: ctx.viewer.storeId,
          adminUserId: ctx.viewer.userId,
          schemaVersion: ANALYTICS_LAYOUT_SCHEMA_VERSION,
          layout: storedAnalyticsLayout(sections),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [
            analyticsDashboardLayouts.storeId,
            analyticsDashboardLayouts.adminUserId,
          ],
          set: {
            schemaVersion: ANALYTICS_LAYOUT_SCHEMA_VERSION,
            layout: storedAnalyticsLayout(sections),
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
