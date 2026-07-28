"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Store, MapPin, ExternalLink, Gem, Check, Loader2 } from "lucide-react";
import { enablePos, disablePos } from "@/app/actions/pos-location-actions";
import { PLAN_META } from "@/lib/plans";
import type { PosState } from "@/lib/pos/locations";

export function PosOverviewClient({
  state,
  locationCount,
  canManage,
}: {
  state: PosState;
  locationCount: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const doEnable = () =>
    start(async () => {
      const res = await enablePos();
      if (res.error) toast.error(res.error);
      else {
        toast.success("Point of Sale enabled");
        router.refresh();
      }
    });

  const doDisable = () =>
    start(async () => {
      const res = await disablePos();
      if (res.error) toast.error(res.error);
      else {
        toast.success("Point of Sale disabled");
        router.refresh();
      }
    });

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <h1>Point of Sale</h1>
        <p>
          Sell in person with an in-store register that shares your catalog,
          inventory, and customers.
        </p>
      </header>

      {/* Centred: states 1 and 2 are a single empty-state card on an otherwise
          blank page, and a narrow column hugging the left edge of a wide
          dashboard reads as a layout bug rather than a deliberate column.
          State 3 is the same narrow width, so it centres with them. */}
      <div className="mx-auto mt-6 max-w-2xl">
        {/* State 1 — not on Pro: included-in-Pro upgrade nudge */}
        {!state.posAvailable && (
          <div className="rounded-2xl border border-[#e5e5e5] bg-white p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#111827]/5 text-[#111827]">
              <Store className="h-7 w-7" strokeWidth={1.75} />
            </div>
            <h2 className="mt-4 text-lg font-bold text-[#111827]">
              Point of Sale is included in Pro
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-[#5b6472]">
              Upgrade to Pro to run an in-store register — barcode checkout,
              cash &amp; card, multi-location inventory, and staff roles. Two
              locations are included.
            </p>
            <Link
              href="/dashboard/plans"
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              <Gem className="h-4 w-4" strokeWidth={2} />
              Upgrade your plan
            </Link>
            <p className="mt-3 text-xs text-[#9aa1ab]">
              You&apos;re on the {PLAN_META[state.plan].name} plan.
            </p>
          </div>
        )}

        {/* State 2 — Pro, not switched on: enable */}
        {state.posAvailable && !state.posEnabled && (
          <div className="rounded-2xl border border-[#e5e5e5] bg-white p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
              <Store className="h-7 w-7" strokeWidth={1.75} />
            </div>
            <h2 className="mt-4 text-lg font-bold text-[#111827]">
              Turn on Point of Sale
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-[#5b6472]">
              Enable POS to add your store locations and open the register at{" "}
              <code className="rounded bg-[#f2f3f5] px-1.5 py-0.5 text-[12px]">
                /pos
              </code>
              . Your Pro plan includes {state.locationsIncluded} locations.
            </p>
            <button
              type="button"
              disabled={!canManage || pending}
              onClick={doEnable}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" strokeWidth={2.5} />
              )}
              Enable POS
            </button>
            {!canManage && (
              <p className="mt-3 text-xs text-[#9aa1ab]">
                Ask a store owner to enable POS.
              </p>
            )}
          </div>
        )}

        {/* State 3 — enabled */}
        {state.posEnabled && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-2xl border border-[#e5e5e5] bg-white p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                  <Store className="h-6 w-6" strokeWidth={1.75} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[#111827]">
                      Point of Sale is on
                    </span>
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
                      Live
                    </span>
                  </div>
                  <p className="text-sm text-[#5b6472]">
                    Register available at /pos on your store.
                  </p>
                </div>
              </div>
              <a
                href="/pos"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                Open register
                <ExternalLink className="h-4 w-4" strokeWidth={2} />
              </a>
            </div>

            <Link
              href="/dashboard/pos/locations"
              className="flex items-center justify-between rounded-2xl border border-[#e5e5e5] bg-white p-5 transition-colors hover:bg-[#fafafa]"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#111827]/5 text-[#111827]">
                  <MapPin className="h-6 w-6" strokeWidth={1.75} />
                </div>
                <div>
                  <div className="font-semibold text-[#111827]">Locations</div>
                  <p className="text-sm text-[#5b6472]">
                    {locationCount}{" "}
                    {locationCount === 1 ? "location" : "locations"} ·{" "}
                    {state.locationsIncluded} included
                  </p>
                </div>
              </div>
              <span className="text-sm font-medium text-[#111827]">
                Manage →
              </span>
            </Link>

            {canManage && (
              <div className="pt-1">
                <button
                  type="button"
                  disabled={pending}
                  onClick={doDisable}
                  className="text-sm font-medium text-[#b42318] transition-opacity hover:opacity-80 disabled:opacity-50"
                >
                  Disable POS
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
