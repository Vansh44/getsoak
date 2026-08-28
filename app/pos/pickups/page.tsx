import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { getPickupQueue } from "@/app/actions/pos-pickup-actions";
import { getRegisterConfig } from "@/app/actions/pos-sale-actions";
import { CounterClient } from "../counter-client";

// Collections waiting on this shop's shelf — plus, through the same box, any
// past order a customer has brought back. One screen with two doors; see the
// header of counter-client.tsx for why the LOOKUP must not split again.
//
// The DOOR is `sell`: handing a collection over is a cashier's job with the
// customer standing there. Marking a box ready is `fulfil_pickup` and taking a
// return is `refund`, both gated per action below and again inside the actions.

export const dynamic = "force-dynamic";
export const metadata = { title: "Pickups — Register" };

export default async function PosPickupsPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  if (!posCan(operator.role, "sell")) redirect("/pos");

  const [{ orders, error }, config] = await Promise.all([
    getPickupQueue(),
    getRegisterConfig(),
  ]);
  const gateway =
    !("error" in config) && config.onlinePayments && config.gatewayKeyId
      ? {
          keyId: config.gatewayKeyId,
          storeName: config.storeName,
          locationName: config.locationName,
        }
      : null;

  return (
    <CounterClient
      mode="pickups"
      initial={orders}
      error={error ?? null}
      canRefund={posCan(operator.role, "refund")}
      canFulfilPickup={posCan(operator.role, "fulfil_pickup")}
      gateway={gateway}
    />
  );
}
