import { redirect } from "next/navigation";
import { getPlatformViewer, getTaxSettings } from "@/app/actions/platform";
import { DEFAULT_TAX_SETTINGS } from "@/lib/billing/platform-settings";
import { TaxSettingsForm } from "./tax-settings-form";

export const metadata = { title: "Billing & tax" };

/**
 * StoreMink's own tax identity (§34).
 *
 * ★ Gated TWICE, deliberately. The console layout already redirects a
 * non-operator, but this page reads and edits the platform's GSTIN — so it does
 * not rely on a parent layout for its authorisation. A layout `notFound()` or
 * redirect does not abort a concurrently-rendering child page (the
 * `requireStorefrontStore` rule, §3), and the same reasoning applies here.
 *
 * Editing is superadmin-only; any operator may LOOK, because "are we charging
 * GST?" is a question support needs answered without a write grant.
 */
export default async function PlatformBillingPage() {
  const viewer = await getPlatformViewer();
  if (!viewer) redirect("/dashboard/login");

  const settings = (await getTaxSettings()) ?? DEFAULT_TAX_SETTINGS;

  return (
    <div className="dash-page-enter">
      <h1 className="text-2xl font-bold text-[#111827]">Billing &amp; tax</h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-[#5b6472]">
        What StoreMink&apos;s own subscription invoices say, and whether they
        charge GST. This is the platform&apos;s tax identity — not a
        merchant&apos;s. A merchant&apos;s own tax settings live in their
        dashboard.
      </p>

      <TaxSettingsForm
        initial={settings}
        canEdit={viewer.role === "superadmin"}
      />
    </div>
  );
}
