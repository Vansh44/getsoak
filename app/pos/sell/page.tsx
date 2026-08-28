import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import {
  getRegisterConfig,
  lookupProducts,
} from "@/app/actions/pos-sale-actions";
import { SellClient } from "./sell-client";
import { getPosExchangeContext } from "@/app/actions/pos-return-actions";

export const metadata = { title: "Sell — Register" };

export default async function PosSellPage({
  searchParams,
}: {
  searchParams: Promise<{ exchange?: string | string[] }>;
}) {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  if (!posCan(operator.role, "sell")) redirect("/pos");

  const exchangeParam = (await searchParams).exchange;
  const exchangeId =
    typeof exchangeParam === "string" ? exchangeParam.slice(0, 80) : null;
  const [config, initial, exchange] = await Promise.all([
    getRegisterConfig(),
    lookupProducts("", 24),
    exchangeId
      ? getPosExchangeContext(exchangeId)
      : Promise.resolve({ context: undefined }),
  ]);
  if ("error" in config) redirect("/pos/login");

  // The idle lock is mounted in app/pos/layout.tsx, which reads the setting
  // itself — every POS screen gets it, not just this one.
  return (
    <SellClient
      config={config}
      initialItems={initial.items}
      exchange={exchange.context ?? null}
      exchangeError={"error" in exchange ? exchange.error : null}
    />
  );
}
