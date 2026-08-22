import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { listDevices, listPosActivity } from "@/app/actions/pos-auth-actions";
import { DevicesClient, RECENT_LIMIT } from "./devices-client";

export const metadata = { title: "POS Devices" };

export default async function PosDevicesPage() {
  const access = await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posEnabled) redirect("/dashboard/pos");

  const [{ devices }, { events }, locations] = await Promise.all([
    listDevices(),
    // Fetch one more than we show, so the client can say "showing the 5 most
    // recent" honestly rather than guessing whether there are more. 30 rows of
    // sign-in history buried the two lists above it that need acting on.
    // ★ SECURITY only. Money events have their own page (/dashboard/pos/money)
    // — mixing them would bury device pairings under a busy shop's discounts,
    // and this list already calls itself "Security activity".
    listPosActivity(RECENT_LIMIT + 1, "security"),
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
