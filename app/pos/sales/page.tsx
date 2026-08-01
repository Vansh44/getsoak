import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { listPosSales } from "@/app/actions/pos-sale-actions";
import { SalesClient } from "./sales-client";

export const dynamic = "force-dynamic";

export default async function PosSalesPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");

  const { sales, error } = await listPosSales();
  return <SalesClient initial={sales} error={error ?? null} />;
}
