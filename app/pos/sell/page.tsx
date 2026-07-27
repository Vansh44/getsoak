import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { getStoreSettings } from "@/lib/settings/resolve";
import {
  getRegisterConfig,
  lookupProducts,
} from "@/app/actions/pos-sale-actions";
import { SellClient } from "./sell-client";

export const metadata = { title: "Sell — Register" };

export default async function PosSellPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  if (!posCan(operator.role, "sell")) redirect("/pos");

  const [config, initial, settings] = await Promise.all([
    getRegisterConfig(),
    lookupProducts("", 24),
    getStoreSettings(),
  ]);
  if ("error" in config) redirect("/pos/login");

  return (
    <SellClient
      config={config}
      initialItems={initial.items}
      idleLockMinutes={Number(settings["pos.idleLockMinutes"]) || 10}
    />
  );
}
