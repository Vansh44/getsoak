import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreLocations } from "@/lib/pos/locations";
import { getPickupQueue } from "@/app/actions/pos-pickup-actions";
import { posCan } from "@/lib/pos/permissions";
import { RegisterHome } from "./register-home";

export default async function PosPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");

  const [locations, pickups] = await Promise.all([
    getStoreLocations(operator.storeId),
    // The tile only appears when this shop actually has collections waiting —
    // a store that doesn't offer pickup never sees it.
    getPickupQueue(),
  ]);
  const locationName =
    locations.find((l) => l.id === operator.locationId)?.name ?? "Location";

  return (
    <RegisterHome
      name={operator.name}
      role={operator.role}
      source={operator.source}
      locationName={locationName}
      deviceAuthorized={operator.deviceAuthorized}
      canAuthorizeDevice={posCan(operator.role, "authorize_device")}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      pickupWaiting={pickups.orders.length}
    />
  );
}
