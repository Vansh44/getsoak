import { asc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { userGroups } from "@/drizzle/schema";
import { getActingStoreId, requireSectionAccess } from "../../../lib/access";
import { CouponForm } from "../coupon-form";
import type { CouponGroup } from "../page";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export default async function NewCouponPage() {
  await requireSectionAccess("marketing", "manage");
  const storeId = await getActingStoreId();
  const { limits } = await getStorePlanContext(storeId);

  const groups = await withService((db) =>
    db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        color: userGroups.color,
      })
      .from(userGroups)
      .where(eq(userGroups.storeId, storeId))
      .orderBy(asc(userGroups.name)),
  ).catch(() => [] as CouponGroup[]);

  return (
    <CouponForm
      coupon={null}
      groups={groups as CouponGroup[]}
      allowsGroups={limits.customerGroups}
    />
  );
}
