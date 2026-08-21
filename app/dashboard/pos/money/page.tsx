import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { listPosActivity } from "@/app/actions/pos-auth-actions";
import { MoneyLogClient } from "./money-log-client";

export const metadata = { title: "POS Money Log" };

// Who gave money away, and who approved it (roadmap Step 14).
//
// Gated on `pos` view like the rest of the section. The amounts themselves are
// on the orders; what this page exists for is ATTRIBUTION — and the approver in
// particular, which nothing else records.
export default async function PosMoneyPage() {
  await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posEnabled) redirect("/dashboard/pos");

  const [{ events, error }, locations] = await Promise.all([
    listPosActivity(200, "money"),
    getStoreLocations(store.id),
  ]);

  return (
    <MoneyLogClient
      events={events}
      error={error}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
    />
  );
}
