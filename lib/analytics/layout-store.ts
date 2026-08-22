import "server-only";

import { and, eq } from "drizzle-orm";
import type { WidgetId } from "@/app/dashboard/analytics/widgets";
import { analyticsDashboardLayouts } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { layoutForViewer, type AnalyticsLayoutView } from "./layout";

export async function getAnalyticsDashboardLayout(
  storeId: string,
  adminUserId: string,
  allowed: readonly WidgetId[],
): Promise<AnalyticsLayoutView> {
  try {
    const [row] = await withService((db) =>
      db
        .select({
          layout: analyticsDashboardLayouts.layout,
          updatedAt: analyticsDashboardLayouts.updatedAt,
        })
        .from(analyticsDashboardLayouts)
        .where(
          and(
            eq(analyticsDashboardLayouts.storeId, storeId),
            eq(analyticsDashboardLayouts.adminUserId, adminUserId),
          ),
        )
        .limit(1),
    );
    return layoutForViewer(
      row?.layout,
      allowed,
      Boolean(row),
      row?.updatedAt ?? null,
    );
  } catch (error) {
    // A missing/pending migration must not take Analytics down. The editor's
    // save will surface the write error; reads safely follow today's default.
    console.error("getAnalyticsDashboardLayout:", error);
    return layoutForViewer(undefined, allowed, false, null);
  }
}
