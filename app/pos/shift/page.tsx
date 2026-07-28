import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { getCurrentShift } from "@/app/actions/pos-shift-actions";
import { getRegisterConfig } from "@/app/actions/pos-sale-actions";
import { ShiftClient } from "./shift-client";

export const metadata = { title: "Cash drawer" };

export default async function PosShiftPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  // A cashier may LOOK — they need to know whether the drawer is open — but
  // every mutating control is gated again in the actions.
  if (!posCan(operator.role, "sell")) redirect("/pos");

  const [state, config] = await Promise.all([
    getCurrentShift(),
    getRegisterConfig(),
  ]);

  return (
    <ShiftClient
      initial={state.shift}
      canManage={state.canManage}
      required={state.required}
      locationName={"error" in config ? "Location" : config.locationName}
    />
  );
}
