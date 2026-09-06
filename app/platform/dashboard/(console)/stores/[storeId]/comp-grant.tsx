"use client";

/**
 * Operator control for comped plans (docs/comped-plans-spec.md).
 *
 * ★★ A GRANT IS NOT AN ACTIVATION. This sets the PLAN and the DURATION; the
 * merchant's acceptance on their own Plans & Billing page sets the window, so a
 * free month counts from the day they take it up rather than burning down
 * unseen from the day it was granted.
 *
 * ★ IT NEVER TOUCHES BILLING. No cycle, no invoice, and `plan` /
 * `plan_source` / `plan_expires_at` are untouched — the comp is resolved on top
 * of the paid entitlement at read time, which is what makes its expiry free.
 *
 * ★ There is no mid-window revocation (spec §12.3), so once a comp is RUNNING
 * this renders a status and no controls. Only an unaccepted offer can be
 * withdrawn.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Gift } from "lucide-react";
import {
  offerCompPlan,
  withdrawCompOffer,
} from "@/app/actions/comp-plan-actions";
import { PLAN_META, type Plan } from "@/lib/plans";

/** Comps are an UPGRADE — 'free' is not a gift, and the server refuses it. */
const COMPABLE: Plan[] = ["basic", "pro"];

function date(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function CompGrantCard({
  storeId,
  comp,
  canManage,
}: {
  storeId: string;
  comp: {
    offer: {
      plan: Plan;
      durationDays: number;
      offeredAt: string | null;
    } | null;
    active: { plan: Plan; startsAt: string; expiresAt: string } | null;
  };
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [plan, setPlan] = useState<Plan>("pro");
  const [days, setDays] = useState("30");

  function run(fn: () => Promise<{ success?: boolean; error?: string }>) {
    start(async () => {
      try {
        const res = await fn();
        if (res.error) toast.error(res.error);
        else toast.success("Done.");
        router.refresh();
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  // Running: a status, not a control. Nothing here can stop it.
  if (comp.active) {
    return (
      <div className="rounded-lg border border-violet-200 bg-violet-50 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-violet-900">
          <Gift className="h-4 w-4" />
          {PLAN_META[comp.active.plan].name} comped until{" "}
          {date(comp.active.expiresAt)}
        </div>
        <p className="mt-1 text-xs text-violet-800">
          Started {date(comp.active.startsAt)}. It runs to the end — there is no
          mid-window cancel. Their own subscription is unaffected and still
          billed.
        </p>
      </div>
    );
  }

  // Offered, not yet accepted.
  if (comp.offer) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="text-sm font-semibold text-slate-800">
          {PLAN_META[comp.offer.plan].name} offered free for{" "}
          {comp.offer.durationDays} days
        </div>
        <p className="mt-1 text-xs text-slate-600">
          Waiting for the merchant to accept on their Plans &amp; Billing page.
          The clock starts then, not now.
          {comp.offer.offeredAt
            ? ` Offered ${date(comp.offer.offeredAt)}.`
            : ""}
        </p>
        {canManage ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => withdrawCompOffer(storeId))}
            className="mt-3 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            {pending ? "Withdrawing…" : "Withdraw offer"}
          </button>
        ) : null}
      </div>
    );
  }

  if (!canManage) return null;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <Gift className="h-4 w-4" />
        Offer a free plan
      </div>
      <p className="mt-1 text-xs text-slate-600">
        A free upgrade on top of whatever they already pay for. Their own
        subscription keeps billing as usual, and when the comp ends they fall
        back to it.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as Plan)}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
          aria-label="Comped plan"
        >
          {COMPABLE.map((p) => (
            <option key={p} value={p}>
              {PLAN_META[p].name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          for
          <input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
            aria-label="Duration in days"
          />
          days
        </label>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            run(() =>
              offerCompPlan(storeId, {
                plan,
                durationDays: Number(days),
              }),
            )
          }
          className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
        >
          {pending ? "Offering…" : "Offer"}
        </button>
      </div>
    </div>
  );
}
