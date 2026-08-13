import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { getShippingSettings } from "@/app/actions/shipping-actions";
import { ShippingSettingsView } from "./shipping-settings-view";

export const metadata = { title: "Shipping & delivery" };

export default async function ShippingSettingsPage() {
  const access = await requireSectionAccess("settings", "view");
  const initial = await getShippingSettings();
  return (
    <ShippingSettingsView
      initial={initial}
      canManage={access.can("settings", "manage")}
    />
  );
}
