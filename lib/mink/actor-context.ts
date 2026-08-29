import "server-only";

import { and, eq } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { adminLocations, orders, products, stores } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { normalizeAnalyticsTimeZone } from "@/lib/analytics/range";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { MinkRequestError } from "./errors";
import { requireMinkStoreInvite } from "./access";
import { getMinkConfig } from "./config";
import type { MinkPageContext } from "./page-context";
import type { MinkActorContext, MinkPlan } from "./types";

const PLANS = new Set<MinkPlan>(["free", "basic", "pro"]);

/** Resolve every authority-bearing field from the authenticated request. */
export async function getMinkActorContext(
  requestId: string,
  options: {
    pageContext?: MinkPageContext;
    betaRequireInvite?: boolean;
  } = {},
): Promise<MinkActorContext> {
  const viewer = await getViewerContext();
  if (!viewer) {
    throw new MinkRequestError("not_signed_in", "Not signed in.", 401);
  }
  if (viewer.dbError) {
    throw new MinkRequestError(
      "permissions_unavailable",
      "Mink AI can't check your permissions right now. Try again shortly.",
      503,
    );
  }
  if (!viewer.profile) {
    throw new MinkRequestError(
      "store_access_denied",
      "You don't have access to this store.",
      403,
    );
  }
  if (!can(viewer.permissions, "dashboard", "view", viewer.isSuperadmin)) {
    throw new MinkRequestError(
      "mink_access_denied",
      "You don't have permission to use Mink AI for this store.",
      403,
    );
  }

  await requireMinkStoreInvite(
    viewer.storeId,
    options.betaRequireInvite ?? getMinkConfig().betaRequireInvite,
  );

  const identity = { uid: viewer.userId, email: viewer.userEmail };
  const trusted = await withUser(identity, async (db) => {
    const storeRows = await db
      .select({ plan: stores.plan, settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, viewer.storeId))
      .limit(1);
    let locationIds: string[] | null = null;
    if (!viewer.isSuperadmin && !viewer.isPlatformAdmin) {
      const bindings = await db
        .select({ locationId: adminLocations.locationId })
        .from(adminLocations)
        .where(
          and(
            eq(adminLocations.adminId, viewer.userId),
            eq(adminLocations.storeId, viewer.storeId),
          ),
        );
      locationIds = bindings.length
        ? bindings.map((binding) => binding.locationId)
        : null;
    }
    const selectedResource = options.pageContext?.selectedResource;
    let validatedSelectedResource = null;
    if (selectedResource?.type === "product") {
      const selected = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.id, selectedResource.id),
            eq(products.storeId, viewer.storeId),
          ),
        )
        .limit(1);
      if (selected[0]) validatedSelectedResource = selectedResource;
    } else if (selectedResource?.type === "order") {
      const selected = await db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.id, selectedResource.id),
            eq(orders.storeId, viewer.storeId),
          ),
        )
        .limit(1);
      if (selected[0]) validatedSelectedResource = selectedResource;
    }
    return {
      store: storeRows[0],
      locationIds,
      selectedResource: validatedSelectedResource,
    };
  });
  const rawPlan = trusted.store?.plan;
  if (!rawPlan || !PLANS.has(rawPlan as MinkPlan)) {
    throw new MinkRequestError(
      "store_unavailable",
      "Mink AI couldn't load this store. Try again shortly.",
      503,
    );
  }

  const settings = resolveStoreSettings(
    (trusted.store?.settings as Record<string, unknown> | undefined) ?? {},
    rawPlan,
  );
  const rawBusiness =
    trusted.store?.settings &&
    typeof trusted.store.settings === "object" &&
    !Array.isArray(trusted.store.settings) &&
    typeof (trusted.store.settings as Record<string, unknown>).business ===
      "object" &&
    !Array.isArray((trusted.store.settings as Record<string, unknown>).business)
      ? ((trusted.store.settings as Record<string, unknown>).business as Record<
          string,
          unknown
        >)
      : {};
  return {
    storeId: viewer.storeId,
    adminId: viewer.userId,
    email: viewer.userEmail,
    roleSlug: viewer.profile.role ?? "",
    permissions: viewer.permissions,
    isSuperadmin: viewer.isSuperadmin,
    effectivePlan: rawPlan as MinkPlan,
    locationIds: trusted.locationIds,
    analyticsTimeZone: normalizeAnalyticsTimeZone(rawBusiness.timeZone),
    currency: "INR",
    defaultLowStockThreshold:
      (settings["inventory.lowStockThreshold"] as number | undefined) ?? 5,
    currentPath: options.pageContext?.currentPath ?? null,
    selectedResource: trusted.selectedResource ?? null,
    requestId,
  };
}
