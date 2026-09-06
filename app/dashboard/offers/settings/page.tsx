import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSectionAccess } from "../../lib/access";
import { getStoreSettingsForEditor } from "@/app/actions/store-settings";
import { FeatureToggles } from "../../components/feature-toggles";

/**
 * Offer settings — the policy every offer in the store is priced under.
 *
 * ★★ A PAGE, NOT A CARD AT THE BOTTOM OF THE LIST. It began as a card below
 * the offers table, which put `offers.autoApply` — the switch that decides
 * whether ANY automatic offer runs at all — at the very end of a scroll nobody
 * reaches. That is most of why the one that mattered went unfound for so long.
 *
 * ★ AND A PAGE RATHER THAN A DIALOG, which was the intermediate step. A dialog
 * cannot be linked to: the offer editor's auto-apply warning and the list's
 * banner both need to send a merchant straight here, and `?settings=1` is a
 * worse address than a route. It also gives the Offers section a second child,
 * which is what earns it the focused sidebar panel (see permissions.ts).
 *
 * ★ GATED ON `promotions` LIKE THE LIST, and `getStoreSettingsForEditor`
 * re-checks each setting's own section on top of that — a hidden toggle is not
 * a permission, and `saveStoreSettings` gates again server-side.
 */
export default async function OfferSettingsPage() {
  const access = await requireSectionAccess("promotions", "view");
  const { plan, settings } = await getStoreSettingsForEditor("Offers");

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <div>
          <Link
            href="/dashboard/offers"
            className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--dash-ink-2)] hover:underline"
          >
            <ArrowLeft size={14} /> Offers
          </Link>
          <h1>Offer settings</h1>
          <p>
            These apply to every offer in your store, online and at the till.
          </p>
        </div>
      </header>

      <div className="max-w-3xl">
        {settings.length === 0 ? (
          <div className="dash-card p-8 text-center text-sm text-[var(--dash-ink-2)]">
            You do not have permission to change offer settings.
          </div>
        ) : (
          <FeatureToggles
            title="How offers behave"
            subtitle="Changes take effect on your storefront and your till immediately."
            successMessage="Offer settings saved."
            plan={plan}
            initialSettings={settings}
            canManage={access.can("promotions", "manage")}
          />
        )}
      </div>
    </div>
  );
}
