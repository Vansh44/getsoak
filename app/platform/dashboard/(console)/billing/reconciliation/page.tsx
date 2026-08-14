import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  getPlatformViewer,
  getReconciliationQueue,
} from "@/app/actions/platform";
import { ReconciliationQueue } from "./queue";

export const metadata = { title: "Reconciliation — StoreMink Admin" };

const TABS = [
  { key: "open", label: "Open" },
  { key: "manual_review", label: "Needs chasing" },
  { key: "resolved", label: "Resolved" },
  { key: "ignored", label: "Ignored" },
] as const;

/**
 * Money discrepancies the sweep found and could not decide (§34).
 *
 * ★ Gated on its own, not on the layout. The console layout already redirects a
 * non-operator, but this page reads across every store's payments, so it does
 * not rely on a parent for its authorisation — a layout redirect does not abort
 * a concurrently-rendering child page (the §3 rule).
 *
 * ★ Any operator may read AND close: closing records a judgement, it does not
 * move money. Who did it is recorded either way.
 */
export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getPlatformViewer();
  if (!viewer) redirect("/dashboard/login");

  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = TABS.some((t) => t.key === raw) ? raw! : "open";

  const items = await getReconciliationQueue(status);

  return (
    <div className="dash-page-enter">
      <Link
        href="/dashboard/billing"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[#5b6472] hover:text-[#111827]"
      >
        <ChevronLeft className="h-4 w-4" />
        Billing &amp; tax
      </Link>

      <h1 className="text-2xl font-bold text-[#111827]">Reconciliation</h1>
      <p className="mt-1 mb-5 max-w-2xl text-sm text-[#5b6472]">
        What the hourly sweep found and could not decide on its own — an amount
        that differs from what we asked for, or a payment that maps to no store.
        The payment itself is always recorded first; these are the questions
        left over.
      </p>

      <div className="mb-5 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/dashboard/billing/reconciliation?status=${t.key}`}
            className={`rounded-full px-3 py-1.5 text-sm ${
              status === t.key
                ? "bg-[#111827] font-medium text-white"
                : "border border-[#e5e5e5] text-[#5b6472] hover:bg-[#111827]/[0.03]"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <ReconciliationQueue items={items} status={status} />
    </div>
  );
}
