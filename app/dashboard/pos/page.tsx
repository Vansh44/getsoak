import { requireSectionAccess } from "../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { PosOverviewClient } from "./pos-overview-client";

export const metadata = { title: "Point of Sale" };

export default async function PosPage() {
  const access = await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  const state = getPosState(store);
  const locationCount = state.posEnabled
    ? (await getStoreLocations(store.id)).length
    : 0;

  return (
    <PosOverviewClient
      state={state}
      locationCount={locationCount}
      canManage={access.can("pos", "manage")}
    />
  );
}
