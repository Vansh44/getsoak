import { getActingStoreId, requireSectionAccess } from "../../lib/access";
import { getStorePlanContext } from "@/lib/plans/entitlements";
import { OfferForm } from "../offer-form";
import { loadOfferScopes } from "../page";

export default async function NewOfferPage() {
  await requireSectionAccess("promotions", "manage");
  const storeId = await getActingStoreId();
  const [{ limits }, { locations, groups, products, categories }] =
    await Promise.all([getStorePlanContext(storeId), loadOfferScopes(storeId)]);

  return (
    <OfferForm
      offer={null}
      locations={locations}
      groups={groups}
      products={products}
      categories={categories}
      initialLocationIds={[]}
      initialGroupIds={[]}
      initialProductIds={[]}
      initialVariantIds={[]}
      initialCategoryIds={[]}
      allowsGroups={limits.customerGroups}
    />
  );
}
