import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { coupons, userGroups } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../../../../lib/access";
import { CouponEmailForm } from "../../coupon-email-form";
import { COUPON_COLUMNS } from "../../page";
import type { Coupon, CouponGroup } from "../../page";
import Link from "next/link";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export default async function CouponEmailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSectionAccess("marketing", "manage");
  const { id } = await params;

  const storeId = await getActingStoreId();
  const { limits } = await getStorePlanContext(storeId);
  if (!limits.emailCampaigns) {
    return (
      <div className="dash-page-enter max-w-2xl">
        <div className="dash-card p-6">
          <h1 className="text-xl font-semibold">Email campaigns require Pro</h1>
          <p className="mt-2 text-sm text-[var(--dash-muted)]">
            Upgrade to create and send coupon campaigns. Existing campaign
            history and queued records are retained through a downgrade.
          </p>
          <Link
            href="/dashboard/plans"
            className="dash-btn dash-btn-primary mt-5"
          >
            View plans
          </Link>
        </div>
      </div>
    );
  }
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
    return { coupon: couponRows[0], groups: groupRows as CouponGroup[] };
  }).catch(() => null);

  if (!result?.coupon) notFound();

  const enriched: Coupon = {
    ...(result.coupon as unknown as Omit<Coupon, "restricted_group_ids">),
    restricted_group_ids: [],
  };

  return <CouponEmailForm coupon={enriched} groups={result.groups} />;
}
