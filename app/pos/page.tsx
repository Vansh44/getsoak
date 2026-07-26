import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreLocations } from "@/lib/pos/locations";
import { getStoreSettings } from "@/lib/settings/resolve";
import { RegisterHome } from "./register-home";

export default async function PosPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");

  const [locations, settings] = await Promise.all([
    getStoreLocations(operator.storeId),
    getStoreSettings(),
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
      canAuthorizeDevice={operator.role === "owner"}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      idleLockMinutes={Number(settings["pos.idleLockMinutes"]) || 10}
    />
  );
}
