import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { getPickupQueue } from "@/app/actions/pos-pickup-actions";
import { PickupsClient } from "./pickups-client";

// The counter: collections waiting on this shop's shelf, and any past order a
// customer has brought back. One screen, because they are one moment — see the
// header of pickups-client.tsx.
//
// The DOOR is `sell`: handing a collection over and reprinting are a cashier's
// job with the customer standing there. Taking a return is `refund` and marking
// a box ready is `fulfil_pickup`, both gated per action below and again inside
// the actions themselves.

export const dynamic = "force-dynamic";
export const metadata = { title: "Pickups — Register" };

export default async function PosPickupsPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  if (!posCan(operator.role, "sell")) redirect("/pos");

  const { orders, error } = await getPickupQueue();

  return (
    <PickupsClient
      initial={orders}
      error={error ?? null}
      canRefund={posCan(operator.role, "refund")}
      canFulfilPickup={posCan(operator.role, "fulfil_pickup")}
    />
  );
}
