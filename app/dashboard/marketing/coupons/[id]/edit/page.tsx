import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { couponUserGroups, coupons, userGroups } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../../../../lib/access";
import { CouponForm } from "../../coupon-form";
import { COUPON_COLUMNS } from "../../page";
import type { Coupon, CouponGroup } from "../../page";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export default async function EditCouponPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSectionAccess("marketing", "manage");
  const { id } = await params;

  const storeId = await getActingStoreId();
  const { limits } = await getStorePlanContext(storeId);
  const result = await withService(async (db) => {
    const couponRows = await db
      .select(COUPON_COLUMNS)
      .from(coupons)
      .where(and(eq(coupons.id, id), eq(coupons.storeId, storeId)))
      .limit(1);
    const groupRows = await db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        color: userGroups.color,
      })
      .from(userGroups)
      .where(eq(userGroups.storeId, storeId))
      .orderBy(asc(userGroups.name));
    const linkRows = await db
      .select({ group_id: couponUserGroups.groupId })
      .from(couponUserGroups)
      .where(
        and(
          eq(couponUserGroups.storeId, storeId),
          eq(couponUserGroups.couponId, id),
        ),
      );
    return {
      coupon: couponRows[0],
      groups: groupRows as CouponGroup[],
      links: linkRows,
    };
  }).catch(() => null);

  if (!result?.coupon) notFound();

  const enriched: Coupon = {
    ...(result.coupon as unknown as Omit<Coupon, "restricted_group_ids">),
    restricted_group_ids: result.links.map((l) => l.group_id),
  };

  return (
    <CouponForm
      coupon={enriched}
      groups={result.groups}
      allowsGroups={limits.customerGroups}
    />
  );
}
