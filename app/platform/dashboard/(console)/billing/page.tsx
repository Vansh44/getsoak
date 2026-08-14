import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getOpenReconciliationCount,
  getPlatformViewer,
  getTaxSettings,
} from "@/app/actions/platform";
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

  const [settings, openItems] = await Promise.all([
    getTaxSettings().then((s) => s ?? DEFAULT_TAX_SETTINGS),
    getOpenReconciliationCount(),
  ]);

  return (
    <div className="dash-page-enter">
      <h1 className="text-2xl font-bold text-[#111827]">Billing &amp; tax</h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-[#5b6472]">
        What StoreMink&apos;s own subscription invoices say, and whether they
        charge GST. This is the platform&apos;s tax identity — not a
        merchant&apos;s. A merchant&apos;s own tax settings live in their
        dashboard.
      </p>

      {/* ★ ABOVE the form, and only when there is something to see. A queue
          nobody looks at is the same as no queue — and these are money
          discrepancies, which do not become less true for being unread. */}
      {openItems > 0 && (
        <Link
          href="/dashboard/billing/reconciliation"
          className="mb-6 flex max-w-3xl items-center justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 transition hover:bg-amber-100"
        >
          <span className="text-sm text-amber-900">
            <strong>
              {openItems} payment{" "}
              {openItems === 1 ? "discrepancy" : "discrepancies"}
            </strong>{" "}
            need{openItems === 1 ? "s" : ""} a look.
          </span>
          <span className="shrink-0 text-sm font-medium text-amber-900">
            Review →
          </span>
        </Link>
      )}

      {/* Always reachable, even at zero — someone looking for the audit trail of
          a closed item should not have to wait for a new one to appear. */}
      {openItems === 0 && (
        <Link
          href="/dashboard/billing/reconciliation"
          className="mb-6 inline-block text-sm text-[#5b6472] hover:text-[#111827] hover:underline"
        >
          Reconciliation queue →
        </Link>
      )}

      <TaxSettingsForm
        initial={settings}
        canEdit={viewer.role === "superadmin"}
      />
    </div>
  );
}
