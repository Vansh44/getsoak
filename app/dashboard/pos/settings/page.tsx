import { redirect } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import { getStoreSettingsForEditor } from "@/app/actions/store-settings";
import { FeatureToggles } from "@/app/dashboard/components/feature-toggles";

export const metadata = { title: "POS Settings" };

export default async function PosSettingsPage() {
  const access = await requireSectionAccess("pos", "view");
  const store = await getCurrentStore();
  if (!getPosState(store).posEnabled) redirect("/dashboard/pos");

  const { plan, settings } = await getStoreSettingsForEditor("Point of Sale");

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <h1>POS Settings</h1>
        <p>How the register behaves for your staff.</p>
      </header>

      <div className="mt-6 max-w-2xl">
        <FeatureToggles
          title="Point of Sale"
          plan={plan}
          initialSettings={settings}
          canManage={access.can("pos", "manage")}
        />
      </div>
    </div>
  );
}
