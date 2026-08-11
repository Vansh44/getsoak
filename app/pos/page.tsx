import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreLocations } from "@/lib/pos/locations";
import { posCan } from "@/lib/pos/permissions";
import { AuthorizeDevice } from "./authorize-client";

// ★ /pos OPENS THE REGISTER — it is no longer a launcher.
//
// It used to render "You're signed in" over a stack of link pills, which every
// shift started with and every screen's back arrow returned to. That is the
// rail's job now (app/pos/pos-nav.tsx), and it does it from anywhere in one tap
// rather than two. So the till opens on the thing it is for.
//
// The one screen left here is the device-authorization prompt. Staff cannot
// resolve as an operator without an authorized device (lib/pos/operator.ts), so
// an unauthorized one is always an owner or superadmin on a fresh browser —
// exactly the person who can fix it.
export default async function PosPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  if (operator.deviceAuthorized) redirect("/pos/sell");

  const locations = await getStoreLocations(operator.storeId);

  return (
    <AuthorizeDevice
      canAuthorize={posCan(operator.role, "authorize_device")}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
    />
  );
}
