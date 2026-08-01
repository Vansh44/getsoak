import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import {
  getFulfilmentRules,
  listLocations,
} from "@/app/actions/location-actions";
import { getStoreSettingsForEditor } from "@/app/actions/store-settings";
import { FeatureToggles } from "@/app/dashboard/components/feature-toggles";
import { FulfilmentClient } from "./fulfilment-client";

export const metadata = { title: "Online fulfilment & pickup" };

export default async function FulfilmentPage() {
  const access = await requireSectionAccess("locations", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posAvailable) redirect("/dashboard/pos");

  const [{ locations, plan }, { rules }, checkout] = await Promise.all([
    listLocations(),
    getFulfilmentRules(),
    getStoreSettingsForEditor("Checkout"),
  ]);

  return (
    <FulfilmentClient
      locations={locations.map((l) => ({
        id: l.id,
        name: l.name,
        active: l.active,
        fulfilsOnline: l.capabilities.online_fulfil,
      }))}
      rules={rules}
      plan={plan}
      canManage={access.can("locations", "manage")}
    >
      {/* Pickup lives here, not on the POS page: a shopper collecting an
          online order is a fulfilment choice that happens to need a till. */}
      <FeatureToggles
        title="Checkout"
        plan={checkout.plan}
        initialSettings={checkout.settings}
        canManage={access.can("locations", "manage")}
      />
    </FulfilmentClient>
  );
}
