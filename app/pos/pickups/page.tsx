import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getPickupQueue } from "@/app/actions/pos-pickup-actions";
import { PickupQueue } from "./pickup-client";

export const dynamic = "force-dynamic";

export default async function PosPickupsPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");

  const { orders, error } = await getPickupQueue();
  return <PickupQueue initial={orders} error={error ?? null} />;
}
