"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Barcode,
  Boxes,
  Check,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Gem,
  Loader2,
  MapPin,
  Store,
  Users,
} from "lucide-react";
import { enablePos, disablePos } from "@/app/actions/location-actions";
import { PLAN_META } from "@/lib/plans";
import type { PosState } from "@/lib/pos/locations";

const POS_UPSELL_FEATURES = [
  { label: "Barcode-fast checkout", icon: Barcode },
  { label: "Cash & card payments", icon: CreditCard },
  { label: "Live inventory sync", icon: Boxes },
  { label: "Staff roles & access", icon: Users },
] as const;

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

      <div className="mx-auto mt-6 w-full max-w-5xl">
        {/* State 1 — not on Pro: feature-led upgrade banner */}
        {!state.posAvailable && (
          <section
            aria-labelledby="pos-upgrade-title"
            className="relative isolate overflow-hidden rounded-[28px] border border-indigo-300/20 bg-[#111329] text-white shadow-[0_28px_80px_-36px_rgba(48,46,129,0.65)]"
          >
            <div
              aria-hidden="true"
              className="absolute -right-24 -top-32 h-96 w-96 rounded-full bg-indigo-500/30 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="absolute -bottom-40 left-1/4 h-80 w-80 rounded-full bg-violet-500/20 blur-3xl"
            />

            <div className="relative grid items-center gap-10 p-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr))] sm:p-8 lg:p-10">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs font-semibold text-indigo-100 backdrop-blur-sm">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-400/20">
                    <Store className="h-3 w-3" strokeWidth={2.25} />
                  </span>
                  StoreMink POS · Included in Pro
                </div>

                <h2
                  id="pos-upgrade-title"
                  className="mt-5 max-w-xl text-3xl font-bold leading-[1.08] tracking-[-0.035em] text-white sm:text-4xl"
                >
                  A faster checkout.
                  <span className="block text-indigo-300">
                    One connected store.
                  </span>
                </h2>
                <p className="mt-4 max-w-xl text-sm leading-6 text-slate-300 sm:text-[15px]">
                  Turn any counter into a powerful register that already knows
                  your catalog, customers, and stock—so every sale stays in
                  sync, online and in store.
                </p>

                <ul className="mt-6 grid gap-2.5 sm:grid-cols-2">
                  {POS_UPSELL_FEATURES.map(({ label, icon: Icon }) => (
                    <li
                      key={label}
                      className="flex items-center gap-2.5 text-sm text-slate-200"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/8 bg-white/6 text-indigo-300">
                        <Icon className="h-4 w-4" strokeWidth={1.9} />
                      </span>
                      {label}
                    </li>
                  ))}
                </ul>

                <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Link
                    href="/dashboard/plans"
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#17182d] shadow-sm transition hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#111329]"
                  >
                    <Gem className="h-4 w-4 text-indigo-600" strokeWidth={2} />
                    Upgrade to Pro
                  </Link>
                  <a
                    href="https://pos.storemink.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/6 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#111329]"
                  >
                    Explore all POS features
                    <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
                  </a>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1.5 text-slate-300">
                    <CheckCircle2
                      className="h-3.5 w-3.5 text-emerald-400"
                      strokeWidth={2.25}
                    />
                    2 locations included with Pro
                  </span>
                  <span>
                    You&apos;re on the {PLAN_META[state.plan].name} plan.
                  </span>
                </div>
              </div>

              <div className="relative mx-auto w-full max-w-md lg:ml-auto">
                <div className="rounded-[22px] border border-white/15 bg-white/10 p-2 shadow-2xl shadow-black/30 backdrop-blur-md">
                  <div className="overflow-hidden rounded-2xl bg-[#f8f9fc] text-[#17182d] shadow-sm">
                    <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
                          <Store className="h-4 w-4" strokeWidth={2} />
                        </span>
                        <div>
                          <p className="text-xs font-bold">New sale</p>
                          <p className="text-[10px] text-slate-500">
                            Main counter
                          </p>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Synced
                      </span>
                    </div>

                    <div className="space-y-2 p-3 sm:p-4">
                      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                          <Barcode className="h-5 w-5" strokeWidth={1.8} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold">
                            Everyday essentials
                          </p>
                          <p className="mt-0.5 text-[10px] text-slate-500">
                            Scanned · Qty 2
                          </p>
                        </div>
                        <span className="text-xs font-bold">₹1,798</span>
                      </div>

                      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
                          <Users className="h-5 w-5" strokeWidth={1.8} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold">
                            Customer attached
                          </p>
                          <p className="mt-0.5 text-[10px] text-slate-500">
                            Orders and history connected
                          </p>
                        </div>
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      </div>
                    </div>

                    <div className="border-t border-slate-200 bg-white p-4">
                      <div className="mb-3 flex items-end justify-between">
                        <span className="text-[11px] font-medium text-slate-500">
                          Total
                        </span>
                        <span className="text-xl font-bold tracking-tight">
                          ₹1,798.00
                        </span>
                      </div>
                      <div className="flex h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 text-xs font-bold text-white shadow-lg shadow-indigo-600/20">
                        <CreditCard className="h-4 w-4" strokeWidth={2} />
                        Take payment
                      </div>
                    </div>
                  </div>
                </div>

                <div className="absolute -bottom-4 -left-4 hidden items-center gap-2 rounded-xl border border-white/10 bg-[#202342]/95 px-3 py-2 text-xs font-semibold text-white shadow-xl backdrop-blur-md sm:flex">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-400/15 text-emerald-300">
                    <Boxes className="h-3.5 w-3.5" strokeWidth={2} />
                  </span>
                  Inventory updated instantly
                </div>
              </div>
            </div>
          </section>
        )}

        {/* States 2 and 3 keep the focused management width. */}
        {state.posAvailable && (
          <div className="mx-auto max-w-2xl">
            {/* State 2 — Pro, not switched on: enable */}
            {!state.posEnabled && (
              <div className="rounded-2xl border border-[#e5e5e5] bg-white p-8 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
                  <Store className="h-7 w-7" strokeWidth={1.75} />
                </div>
                <h2 className="mt-4 text-lg font-bold text-[#111827]">
                  Turn on Point of Sale
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-[#5b6472]">
                  Enable POS to add your store locations and open the register
                  at{" "}
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
                      <div className="font-semibold text-[#111827]">
                        Locations
                      </div>
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
        )}
      </div>
    </div>
  );
}
