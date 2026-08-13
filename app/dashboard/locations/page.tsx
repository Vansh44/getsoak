import { redirect } from "next/navigation";
import { requireSectionAccess } from "../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import { listLocations } from "@/app/actions/location-actions";
import { getLocationBilling } from "@/app/actions/subscribe-actions";
import { LocationsClient } from "./locations-client";

export const metadata = { title: "Locations" };

export default async function LocationsPage() {
  const access = await requireSectionAccess("locations", "view");
  const store = await getCurrentStore();
  const state = getPosState(store);

  // Multi-location is Pro. Below that a store has exactly one location and
  // nothing here to decide, so the POS overview owns the upgrade pitch.
  if (!state.posAvailable) redirect("/dashboard/pos");

  const [{ locations, plan }, billing] = await Promise.all([
    listLocations(),
    // Null only when the viewer can't see the section, which requireSectionAccess
    // has already ruled out — but the card handles it rather than assuming.
    getLocationBilling(),
  ]);

  return (
    <LocationsClient
      initialLocations={locations}
      plan={plan}
      canManage={access.can("locations", "manage")}
      locationsIncluded={state.locationsIncluded}
      billing={billing}
    />
  );
}
