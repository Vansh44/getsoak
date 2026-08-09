import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
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

  const [config, initial] = await Promise.all([
    getRegisterConfig(),
    lookupProducts("", 24),
  ]);
  if ("error" in config) redirect("/pos/login");

  // The idle lock is mounted in app/pos/layout.tsx, which reads the setting
  // itself — every POS screen gets it, not just this one.
  return <SellClient config={config} initialItems={initial.items} />;
}
