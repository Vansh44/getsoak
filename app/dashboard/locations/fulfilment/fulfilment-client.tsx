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
import { ArrowLeft, ArrowDown, ArrowUp, Loader2 } from "lucide-react";
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

      <section className="mt-5 max-w-2xl rounded-xl border border-[#e5e5e5] bg-white p-5">
        <h2 className="font-semibold text-[#111827]">Strategy</h2>
        <div className="mt-3 space-y-2">
          {FULFILMENT_STRATEGIES.map((s) => {
            const locked = s.minPlan && !planAllows(plan, s.minPlan);
            return (
              <label key={s.id} className="flex gap-3 text-sm">
                <input
                  type="radio"
                  checked={rules.strategy === s.id}
                  disabled
                  className="mt-0.5 accent-[#111827]"
                />
                <span>
                  <span className="block font-medium text-[#111827]">
                    {s.label}
                  </span>
                  <span className="block text-xs text-[#5b6472]">
                    {s.description}
                  </span>
                  {locked && (
                    <span className="text-xs text-[#9aa1ab]">
                      Available on {s.minPlan}.
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          <p className="text-xs text-[#9aa1ab]">
            Nearest, most stock and cheapest shipping are planned — each slots
            in here without changing how orders are placed.
          </p>
        </div>

        <h2 className="mt-6 font-semibold text-[#111827]">Order</h2>
        <p className="mt-1 text-sm text-[#5b6472]">
          The first location with enough stock fulfils the order.
        </p>

        <ol className="mt-3 space-y-2">
          {order.map((id, i) => {
            const l = byId.get(id);
            if (!l) return null;
            return (
              <li
                key={id}
                className="flex items-center gap-3 rounded-lg border border-[#e5e5e5] p-3"
              >
                <span className="w-5 text-sm font-semibold text-[#9aa1ab]">
                  {i + 1}
                </span>
                <span className="flex-1 text-sm font-medium text-[#111827]">
                  {l.name}
                  {!l.active && (
                    <span className="ml-2 text-xs font-normal text-[#9aa1ab]">
                      Inactive
                    </span>
                  )}
                </span>
                {canManage && (
                  <span className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${l.name} up`}
                      className="rounded p-1.5 text-[#5b6472] hover:bg-[#111827]/5 disabled:opacity-30"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === order.length - 1}
                      aria-label={`Move ${l.name} down`}
                      className="rounded p-1.5 text-[#5b6472] hover:bg-[#111827]/5 disabled:opacity-30"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
          {order.length === 0 && (
            <li className="rounded-lg border border-dashed border-[#e5e5e5] p-4 text-sm text-[#9aa1ab]">
              No location fulfils online orders. Enable it on a location first —
              until then, orders use your main location.
            </li>
          )}
        </ol>

        {/* Shown rather than hidden: a merchant hunting for their shop needs to
            know WHY it isn't in the list. */}
        {ineligible.length > 0 && (
          <div className="mt-4 border-t border-[#e5e5e5] pt-3">
            <p className="text-xs font-medium text-[#9aa1ab]">
              Not fulfilling online orders
            </p>
            <ul className="mt-1.5 space-y-1">
              {ineligible.map((l) => (
                <li key={l.id} className="text-sm text-[#9aa1ab]">
                  {l.name} ·{" "}
                  <Link
                    href={`/dashboard/locations/${l.id}`}
                    className="underline underline-offset-2 hover:text-[#111827]"
                  >
                    enable it
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {canManage && (
          <>
            <label className="mt-5 flex items-center gap-2 text-sm text-[#111827]">
              <input
                type="checkbox"
                checked={skipInactive}
                onChange={(e) => setSkipInactive(e.target.checked)}
                className="h-4 w-4 accent-[#111827]"
              />
              Skip locations that are deactivated
            </label>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                disabled={pending}
                onClick={save}
                className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </>
        )}
      </section>

      {children}
    </div>
  );
}
