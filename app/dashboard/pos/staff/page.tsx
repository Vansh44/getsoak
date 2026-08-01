import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { listStaff } from "@/app/actions/pos-staff-actions";
import { StaffClient } from "./staff-client";

export const metadata = { title: "POS Staff" };

export default async function PosStaffPage() {
  const access = await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posEnabled) redirect("/dashboard/pos");

  const [{ staff }, locations] = await Promise.all([
    listStaff(),
    getStoreLocations(store.id),
  ]);

  return (
    <StaffClient
      initialStaff={staff}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      canManage={access.can("pos", "manage")}
    />
  );
}
