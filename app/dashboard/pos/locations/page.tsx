import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { LocationsClient } from "./locations-client";

export const metadata = { title: "POS Locations" };

export default async function PosLocationsPage() {
  const access = await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  const state = getPosState(store);

  // POS off → the overview page owns the upgrade / enable flow.
  if (!state.posEnabled) redirect("/dashboard/pos");

  const locations = await getStoreLocations(store.id);

  return (
    <LocationsClient
      initialLocations={locations}
      canManage={access.can("pos", "manage")}
      locationsIncluded={state.locationsIncluded}
    />
  );
}
