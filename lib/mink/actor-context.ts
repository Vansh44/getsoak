import "server-only";

import { eq } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { getViewerContext } from "@/app/dashboard/lib/access";
import { stores } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { MinkRequestError } from "./errors";
import type { MinkActorContext, MinkPlan } from "./types";

const PLANS = new Set<MinkPlan>(["free", "basic", "pro"]);

/** Resolve every authority-bearing field from the authenticated request. */
export async function getMinkActorContext(
  requestId: string,
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

  const identity = { uid: viewer.userId, email: viewer.userEmail };
  const rows = await withUser(identity, (db) =>
    db
      .select({ plan: stores.plan })
      .from(stores)
      .where(eq(stores.id, viewer.storeId))
      .limit(1),
  );
  const rawPlan = rows[0]?.plan;
  if (!rawPlan || !PLANS.has(rawPlan as MinkPlan)) {
    throw new MinkRequestError(
      "store_unavailable",
      "Mink AI couldn't load this store. Try again shortly.",
      503,
    );
  }

  return {
    storeId: viewer.storeId,
    adminId: viewer.userId,
    email: viewer.userEmail,
    roleSlug: viewer.profile.role ?? "",
    permissions: viewer.permissions,
    isSuperadmin: viewer.isSuperadmin,
    effectivePlan: rawPlan as MinkPlan,
    requestId,
  };
}
