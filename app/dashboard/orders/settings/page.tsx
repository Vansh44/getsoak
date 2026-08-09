import { requireSectionAccess } from "../../lib/access";
import { getStoreSettingsForEditor } from "@/app/actions/store-settings";
import { FeatureToggles } from "@/app/dashboard/components/feature-toggles";

// Order settings — today just self-serve cancellation (roadmap Step 2).
//
// Gated on the `orders` section rather than a new permission key: cancelling
// an order is an order operation, and anyone who can already manage orders can
// already do by hand what this setting lets a customer do for themselves.
export default async function OrderSettingsPage() {
  const access = await requireSectionAccess("orders", "view");

  const { plan, settings } = await getStoreSettingsForEditor("Orders");

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <h1>Order Settings</h1>
        <p>Choose what shoppers can do with an order after they place it</p>
      </header>

      <div className="max-w-2xl mt-6">
        <FeatureToggles
          title="Cancellations"
          plan={plan}
          initialSettings={settings}
          canManage={access.can("orders", "manage")}
        />
        <p className="mt-3 text-sm text-muted-foreground">
          Requests wait in <strong>Orders → Cancellations</strong> unless you
          switch approval to automatic. When you approve one you choose where
          the money goes — nothing is refunded without you saying so.
        </p>
      </div>
    </div>
  );
}
