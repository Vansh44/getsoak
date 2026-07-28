import { redirect } from "next/navigation";
import { requireSectionAccess } from "../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import { listLocations } from "@/app/actions/location-actions";
import { LocationsClient } from "./locations-client";

export const metadata = { title: "Locations" };

export default async function LocationsPage() {
  const access = await requireSectionAccess("locations", "view");
  const store = await getCurrentStore();
  const state = getPosState(store);

  // Multi-location is Pro. Below that a store has exactly one location and
  // nothing here to decide, so the POS overview owns the upgrade pitch.
  if (!state.posAvailable) redirect("/dashboard/pos");

  const { locations, plan } = await listLocations();

  return (
    <LocationsClient
      initialLocations={locations}
      plan={plan}
      canManage={access.can("locations", "manage")}
      locationsIncluded={state.locationsIncluded}
    />
  );
}
