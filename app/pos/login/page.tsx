import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { getStoreLocations } from "@/lib/pos/locations";
import { getAuthorizedDevice } from "@/lib/pos/devices";
import { PosLoginClient } from "./login-client";

export default async function PosLoginPage() {
  // Owner session or an active operator → straight to the register.
  const operator = await resolvePosOperator();
  if (operator) redirect("/pos");

  const storeId = await getCurrentStoreId();
  const device = await getAuthorizedDevice(storeId);
  let locationName: string | null = null;
  if (device) {
    const locations = await getStoreLocations(storeId);
    locationName =
      locations.find((l) => l.id === device.locationId)?.name ?? null;
  }

  return <PosLoginClient locationName={locationName} />;
}
