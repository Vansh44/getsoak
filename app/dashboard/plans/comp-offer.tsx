"use client";

/**
 * The comped-plan surfaces on Plans & Billing (docs/comped-plans-spec.md).
 *
 * Two states, deliberately different shapes:
 *
 *   - an OFFER the operator has left, which the merchant accepts. Accepting is
 *     what starts the clock, so a free month counts from the day it is taken up
 *     rather than burning down unseen.
 *   - a RUNNING comp, which is a status, not an action. There is no
 *     mid-window cancel (spec §12.3), so it renders no button.
 *
 * ★★ THE COPY IS LOAD-BEARING, not decoration. The merchant keeps paying their
 * own subscription throughout — a comp is a free UPGRADE, not a payment holiday
 * (spec §12.1). Saying "one month of Pro, free" and then charging their Basic
 * bill four days later reads as a broken promise, so both states say plainly
 * that the existing plan continues and is billed as usual.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Gift, Sparkles } from "lucide-react";
import { activateCompPlan } from "@/app/actions/comp-plan-actions";
import { PLAN_META, normalizePlan } from "@/lib/plans";

function planName(plan: string): string {
  return PLAN_META[normalizePlan(plan)].name;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Whole days left, rounded up — "ends in 0 days" is never the right sentence. */
function daysLeft(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function CompOfferCard({
  offer,
  currentPlanName,
  canManage,
}: {
  offer: { plan: string; durationDays: number };
  /** What they are on today — named so "continues as usual" is concrete. */
  currentPlanName: string;
  /** Accepting changes the plan, so a view-only admin sees the offer without a
   *  button rather than one that always fails at the server (§23's rule). */
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const name = planName(offer.plan);

  function accept() {
    start(async () => {
      // ★ An action that throws inside startTransition leaves `pending` true
      // forever and surfaces nothing (the §25 policy-gate lesson).
      try {
        const res = await activateCompPlan();
        if (res.error) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        setDone(true);
        toast.success(
          res.expiresAt
            ? `${planName(res.plan ?? offer.plan)} is on until ${formatDate(res.expiresAt)}.`
            : `${name} is on.`,
        );
        router.refresh();
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <section className="rounded-xl border border-violet-300 bg-violet-50 p-6">
      <div className="flex items-start gap-3">
        <Gift className="mt-0.5 h-5 w-5 shrink-0 text-violet-600" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-violet-900">
            Free upgrade to {name} for {offer.durationDays} days
          </h2>
          {/* The two sentences the owner signed off. Do not trim them: the
              second is the whole reason this is not a broken promise. */}
          <p className="mt-1 text-sm text-violet-800">
            Your {currentPlanName} plan continues and is billed as usual.
          </p>
          <p className="mt-1 text-sm text-violet-800">
            Starts when you accept. When it ends you go back to{" "}
            {currentPlanName} — nothing else changes.
          </p>

          {canManage ? (
            <button
              type="button"
              onClick={accept}
              disabled={pending || done}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-800 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {pending
                ? "Starting…"
                : done
                  ? "Started"
                  : `Start my free ${name}`}
            </button>
          ) : (
            <p className="mt-4 text-sm font-medium text-violet-900">
              Ask an admin who can manage billing to start it.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export function CompActiveNotice({
  comp,
  paidPlanName,
}: {
  comp: { plan: string; expiresAt: string };
  /** The plan underneath, which they keep paying for and fall back to. */
  paidPlanName: string;
}) {
  const name = planName(comp.plan);
  const left = daysLeft(comp.expiresAt);
  return (
    <section className="rounded-xl border border-violet-300 bg-violet-50 p-6">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-violet-600" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-violet-900">
            {name} is free until {formatDate(comp.expiresAt)}
          </h2>
          <p className="mt-1 text-sm text-violet-800">
            {left === 1 ? "1 day left" : `${left} days left`}. Your{" "}
            {paidPlanName} plan continues and is billed as usual — when this
            ends you go back to {paidPlanName}.
          </p>
        </div>
      </div>
    </section>
  );
}
