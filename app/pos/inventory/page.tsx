import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import {
  getPosInventory,
  getTransferTargets,
} from "@/app/actions/pos-inventory-actions";
import { getRegisterConfig } from "@/app/actions/pos-sale-actions";
import { InventoryClient } from "./inventory-client";

export const metadata = { title: "Stock" };

export default async function PosInventoryPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  // A cashier sells stock but does not get to declare how much exists; the
  // actions gate again, this keeps the screen off their device entirely.
  if (!posCan(operator.role, "adjust_inventory")) redirect("/pos");

  const [inventory, targets, config] = await Promise.all([
    getPosInventory({ limit: 50 }),
    getTransferTargets(),
    getRegisterConfig(),
  ]);

  return (
    <InventoryClient
      initial={inventory.items}
      targets={targets.targets}
      locationName={"error" in config ? "Location" : config.locationName}
    />
  );
}
