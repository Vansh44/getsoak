import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import { getShiftHistory } from "@/app/actions/pos-shift-actions";
import { ShiftsClient } from "./shifts-client";

export const metadata = { title: "POS Shifts" };

// Shift history and Z-reports for the dashboard (roadmap Step 17).
//
// Until this existed a shift's figures lived ONLY at the till: an owner could
// not see yesterday's drawer, compare two shops, or look at a variance without
// standing at a counter.
export default async function PosShiftsPage() {
  await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posEnabled) redirect("/dashboard/pos");

  const { shifts, error } = await getShiftHistory(100);
  return <ShiftsClient shifts={shifts} error={error} />;
}
