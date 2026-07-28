import { notFound, redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import { listLocations } from "@/app/actions/location-actions";
import { LocationEditor } from "./location-editor";

export const metadata = { title: "Location" };

export default async function LocationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const access = await requireSectionAccess("locations", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posAvailable) redirect("/dashboard/pos");

  const { locations, plan } = await listLocations();
  const location = locations.find((l) => l.id === id);
  if (!location) notFound();

  // Whether this is the ONLY location that fulfils online orders decides if
  // that checkbox can be unticked at all — computed here so the UI can say why
  // rather than just refusing on save.
  const otherFulfils = locations.some(
    (l) => l.id !== id && l.capabilities.online_fulfil,
  );

  return (
    <LocationEditor
      location={location}
      plan={plan}
      canManage={access.can("locations", "manage")}
      isOnlyFulfilmentLocation={!otherFulfils}
    />
  );
}
