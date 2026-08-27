"use client";

// Where online orders ship from, and in what order (roadmap Phase D).
//
// Only the ORDER is set here — whether a location fulfils online at all is a
// capability, set on the location itself. Locations without it are still shown,
// greyed with the reason: a merchant who can't find their shop in this list
// otherwise assumes the page is broken.

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Loader2,
  MapPin,
  Route,
} from "lucide-react";
import {
  saveFulfilmentRules,
  type FulfilmentRules,
} from "@/app/actions/location-actions";
import { FULFILMENT_STRATEGIES } from "@/lib/fulfilment/strategies";
import { planAllows, type Plan } from "@/lib/plans";

type Loc = {
  id: string;
  name: string;
  active: boolean;
  fulfilsOnline: boolean;
};

export function FulfilmentClient({
  locations,
  rules,
  plan,
  canManage,
  children,
}: {
  locations: Loc[];
  rules: FulfilmentRules;
  plan: Plan;
  canManage: boolean;
  /** Server-rendered cards shown under the routing panel (pickup settings). */
  children?: React.ReactNode;
}) {
  const eligible = locations.filter((l) => l.fulfilsOnline);
  const ineligible = locations.filter((l) => !l.fulfilsOnline);

  // Saved order first, then anything eligible that was never placed — the same
  // rule the resolver applies, so this screen shows what will actually happen.
  const [order, setOrder] = useState<string[]>(() => {
    const known = rules.priority.filter((id) =>
      eligible.some((l) => l.id === id),
    );
    for (const l of eligible) if (!known.includes(l.id)) known.push(l.id);
    return known;
  });
  const [skipInactive, setSkipInactive] = useState(rules.skipInactive);
  const [pending, start] = useTransition();

  const byId = new Map(locations.map((l) => [l.id, l]));

  const move = (i: number, delta: number) =>
    setOrder((o) => {
      const j = i + delta;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = () =>
    start(async () => {
      const res = await saveFulfilmentRules({
        strategy: rules.strategy,
        priority: order,
        skipInactive,
      });
      if (res.error) toast.error(res.error);
      else toast.success("Fulfilment rules saved");
    });

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <Link
          href="/dashboard/locations"
          className="mb-2 inline-flex items-center gap-1.5 text-sm text-[#5b6472] transition-colors hover:text-[#111827]"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} />
          Locations
        </Link>
        <h1 className="text-xl font-semibold text-[#111827]">
          Online fulfilment &amp; pickup
        </h1>
        <p className="mt-1 text-sm text-[#5b6472]">
          Which locations ship website orders, which is tried first, and whether
          shoppers can collect in store.
        </p>
      </header>

      <div
        className="mt-5 max-w-5xl space-y-5"
        data-testid="fulfilment-workspace"
      >
        <section className="overflow-hidden rounded-xl border border-[#e5e5e5] bg-white">
          <div className="flex items-start gap-3 border-b border-[#e5e5e5] px-5 py-4 sm:px-6">
            <span className="mt-0.5 rounded-lg bg-[#f3f4f6] p-2 text-[#111827]">
              <Route className="h-4 w-4" strokeWidth={2} />
            </span>
            <div>
              <h2 className="font-semibold text-[#111827]">
                Website order routing
              </h2>
              <p className="mt-0.5 text-sm text-[#5b6472]">
                Choose how StoreMink selects a location and which one it tries
                first.
              </p>
            </div>
          </div>

          <div className="grid lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
            <div className="border-b border-[#e5e5e5] p-5 sm:p-6 lg:border-r lg:border-b-0">
              <p className="text-xs font-semibold tracking-wide text-[#6b7280] uppercase">
                Routing method
              </p>
              <div className="mt-3 space-y-2">
                {FULFILMENT_STRATEGIES.map((strategy) => {
                  const selected = rules.strategy === strategy.id;
                  const locked =
                    strategy.minPlan && !planAllows(plan, strategy.minPlan);
                  return (
                    <div
                      key={strategy.id}
                      className={`rounded-lg border p-3.5 ${
                        selected
                          ? "border-[#111827] bg-[#f8f8f8]"
                          : "border-[#e5e5e5]"
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <CheckCircle2
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            selected ? "text-[#111827]" : "text-[#c4c8ce]"
                          }`}
                          strokeWidth={2}
                        />
                        <div>
                          <p className="text-sm font-medium text-[#111827]">
                            {strategy.label}
                          </p>
                          <p className="mt-0.5 text-xs leading-5 text-[#5b6472]">
                            {strategy.description}
                          </p>
                          {locked && (
                            <p className="mt-1 text-xs text-[#9aa1ab]">
                              Available on {strategy.minPlan}.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs leading-5 text-[#9aa1ab]">
                Additional routing methods will appear here when available.
              </p>
            </div>

            <div className="p-5 sm:p-6">
              <div>
                <p className="text-xs font-semibold tracking-wide text-[#6b7280] uppercase">
                  Location priority
                </p>
                <p className="mt-1 text-sm text-[#5b6472]">
                  The first eligible location with enough stock fulfils the
                  whole order.
                </p>
              </div>

              <ol className="mt-4 space-y-2">
                {order.map((id, index) => {
                  const location = byId.get(id);
                  if (!location) return null;
                  return (
                    <li
                      key={id}
                      className="flex min-h-14 items-center gap-3 rounded-lg border border-[#e5e5e5] bg-white px-3 py-2.5"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#f3f4f6] text-xs font-semibold text-[#5b6472]">
                        {index + 1}
                      </span>
                      <MapPin
                        className="h-4 w-4 shrink-0 text-[#9aa1ab]"
                        strokeWidth={2}
                      />
                      <span className="min-w-0 flex-1 text-sm font-medium text-[#111827]">
                        {location.name}
                        {!location.active && (
                          <span className="ml-2 rounded-full bg-[#f3f4f6] px-2 py-0.5 text-[11px] font-medium text-[#6b7280]">
                            Inactive
                          </span>
                        )}
                      </span>
                      {canManage && (
                        <span className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => move(index, -1)}
                            disabled={index === 0}
                            aria-label={`Move ${location.name} up`}
                            className="rounded-md border border-transparent p-1.5 text-[#5b6472] transition-colors hover:border-[#e5e5e5] hover:bg-[#f8f8f8] disabled:pointer-events-none disabled:opacity-25"
                          >
                            <ArrowUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(index, 1)}
                            disabled={index === order.length - 1}
                            aria-label={`Move ${location.name} down`}
                            className="rounded-md border border-transparent p-1.5 text-[#5b6472] transition-colors hover:border-[#e5e5e5] hover:bg-[#f8f8f8] disabled:pointer-events-none disabled:opacity-25"
                          >
                            <ArrowDown className="h-4 w-4" />
                          </button>
                        </span>
                      )}
                    </li>
                  );
                })}
                {order.length === 0 && (
                  <li className="rounded-lg border border-dashed border-[#d8dadd] bg-[#fafafa] p-4 text-sm leading-5 text-[#6b7280]">
                    No location fulfils online orders. Enable it on a location
                    first; until then, orders use your main location.
                  </li>
                )}
              </ol>

              {/* Shown rather than hidden: a merchant hunting for their shop
                  needs to know why it is not in the routing list. */}
              {ineligible.length > 0 && (
                <div className="mt-4 rounded-lg bg-[#f8f8f8] p-3.5">
                  <p className="text-xs font-semibold text-[#6b7280]">
                    Not fulfilling online orders
                  </p>
                  <ul className="mt-2 space-y-2">
                    {ineligible.map((location) => (
                      <li
                        key={location.id}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="min-w-0 truncate text-[#6b7280]">
                          {location.name}
                        </span>
                        <Link
                          href={`/dashboard/locations/${location.id}`}
                          className="shrink-0 font-medium text-[#111827] underline decoration-[#c4c8ce] underline-offset-2 hover:decoration-[#111827]"
                        >
                          Enable in location
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {canManage && (
            <div className="flex flex-col gap-3 border-t border-[#e5e5e5] bg-[#fafafa] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <label className="flex items-center gap-2.5 text-sm text-[#111827]">
                <input
                  type="checkbox"
                  checked={skipInactive}
                  onChange={(event) => setSkipInactive(event.target.checked)}
                  className="h-4 w-4 rounded border-[#c4c8ce] accent-[#111827]"
                />
                Skip deactivated locations
              </label>
              <button
                type="button"
                disabled={pending}
                onClick={save}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save routing
              </button>
            </div>
          )}
        </section>

        {children}
      </div>
    </div>
  );
}
