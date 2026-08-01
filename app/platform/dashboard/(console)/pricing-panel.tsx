"use client";

import { useState, useTransition } from "react";
import { savePlanPricing, type PlanPriceInput } from "@/app/actions/platform";
import type { PlanPricing } from "@/lib/plans/pricing";

// ---------------------------------------------------------------------------
// Plan pricing, editable by a platform superadmin.
//
// Two prices per plan. `Charged` is what a merchant actually pays and what
// Razorpay bills. `Was` is the struck-through list price on the pricing page —
// display only, never charged, blank when no offer is running.
//
// The save action re-validates everything server-side; the checks here exist
// to give an answer before a round trip, not instead of one.
// ---------------------------------------------------------------------------

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

type Row = {
  plan: string;
  monthlyInr: string;
  yearlyInr: string;
  baseMonthlyInr: string;
  baseYearlyInr: string;
};

function toRows(pricing: PlanPricing): Row[] {
  return Object.entries(pricing).map(([plan, p]) => ({
    plan,
    monthlyInr: String(p.monthlyInr),
    yearlyInr: String(p.yearlyInr),
    baseMonthlyInr: p.baseMonthlyInr === null ? "" : String(p.baseMonthlyInr),
    baseYearlyInr: p.baseYearlyInr === null ? "" : String(p.baseYearlyInr),
  }));
}

export function PricingPanel({ pricing }: { pricing: PlanPricing }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(pricing));
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [pending, start] = useTransition();

  const set = (plan: string, key: keyof Row, value: string) => {
    // Digits only — a stray "₹" or a comma would fail server validation with a
    // less useful message than simply not accepting the character.
    const clean = value.replace(/[^\d]/g, "");
    setRows((r) =>
      r.map((x) => (x.plan === plan ? { ...x, [key]: clean } : x)),
    );
    setMsg({});
  };

  const save = () => {
    const payload: PlanPriceInput[] = rows.map((r) => ({
      plan: r.plan,
      monthlyInr: Number(r.monthlyInr || 0),
      yearlyInr: Number(r.yearlyInr || 0),
      baseMonthlyInr: r.baseMonthlyInr === "" ? null : Number(r.baseMonthlyInr),
      baseYearlyInr: r.baseYearlyInr === "" ? null : Number(r.baseYearlyInr),
    }));
    start(async () => {
      const res = await savePlanPricing(payload);
      setMsg(res.error ? { error: res.error } : { ok: "Pricing updated." });
    });
  };

  return (
    <section className="stq-card">
      <header className="mb-4">
        <h2 className="text-lg font-bold">Plan pricing</h2>
        <p className="text-sm text-[var(--stq-muted)]">
          Changes show on the pricing page immediately.{" "}
          <b>Anyone already subscribed keeps the price they signed up at</b> — a
          new price creates a new Razorpay plan and never reprices a live
          mandate.
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--stq-muted)]">
              <th className="py-2 pr-4 font-medium">Plan</th>
              <th className="py-2 pr-4 font-medium">Charged / month</th>
              <th className="py-2 pr-4 font-medium">Charged / year</th>
              <th className="py-2 pr-4 font-medium">Was / month</th>
              <th className="py-2 pr-4 font-medium">Was / year</th>
              <th className="py-2 font-medium">On the page</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const monthly = Number(r.monthlyInr || 0);
              const yearly = Number(r.yearlyInr || 0);
              const perMonth = yearly > 0 ? Math.round(yearly / 12) : 0;
              return (
                <tr key={r.plan} className="border-t border-[var(--stq-line)]">
                  <td className="py-3 pr-4 font-semibold capitalize">
                    {r.plan}
                  </td>
                  {(
                    [
                      "monthlyInr",
                      "yearlyInr",
                      "baseMonthlyInr",
                      "baseYearlyInr",
                    ] as const
                  ).map((key) => (
                    <td className="py-3 pr-4" key={key}>
                      <input
                        className="stq-input w-28"
                        inputMode="numeric"
                        value={r[key]}
                        placeholder={key.startsWith("base") ? "none" : "0"}
                        onChange={(e) => set(r.plan, key, e.target.value)}
                        aria-label={`${r.plan} ${key}`}
                      />
                    </td>
                  ))}
                  <td className="py-3 text-[var(--stq-muted)]">
                    {monthly === 0 && yearly === 0 ? (
                      "Free"
                    ) : (
                      <>
                        <b className="text-[var(--stq-ink)]">{inr(perMonth)}</b>
                        /mo on yearly · {inr(monthly)}/mo monthly
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="stq-btn stq-btn-primary"
        >
          {pending ? "Saving…" : "Save pricing"}
        </button>
        {msg.ok && (
          <span className="text-sm text-[var(--stq-ok)]">{msg.ok}</span>
        )}
        {msg.error && (
          <span className="text-sm text-[var(--stq-bad)]">{msg.error}</span>
        )}
      </div>

      <p className="mt-3 text-xs text-[var(--stq-muted)]">
        Leave a “Was” field blank when no offer is running — the page then shows
        one price with no strike-through. A “Was” price must be at least the
        price you charge.
      </p>
    </section>
  );
}
