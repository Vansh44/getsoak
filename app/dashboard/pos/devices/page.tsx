import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { listDevices, listPosActivity } from "@/app/actions/pos-auth-actions";
import { DevicesClient } from "./devices-client";

export const metadata = { title: "POS Devices" };

export default async function PosDevicesPage() {
  const access = await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posEnabled) redirect("/dashboard/pos");

  const [{ devices }, { events }, locations] = await Promise.all([
    listDevices(),
    listPosActivity(30),
    getStoreLocations(store.id),
  ]);

  return (
    <DevicesClient
      initialDevices={devices}
      events={events}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      canManage={access.can("pos", "manage")}
    />
  );
}
