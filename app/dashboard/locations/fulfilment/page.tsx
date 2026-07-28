import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import {
  getFulfilmentRules,
  listLocations,
} from "@/app/actions/location-actions";
import { FulfilmentClient } from "./fulfilment-client";

export const metadata = { title: "Online fulfilment" };

export default async function FulfilmentPage() {
  const access = await requireSectionAccess("locations", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posAvailable) redirect("/dashboard/pos");

  const [{ locations, plan }, { rules }] = await Promise.all([
    listLocations(),
    getFulfilmentRules(),
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
    />
  );
}
