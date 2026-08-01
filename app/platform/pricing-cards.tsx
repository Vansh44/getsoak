"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";

// ---------------------------------------------------------------------------
// The pricing cards, with the monthly/yearly switch.
//
// DEFAULTS TO YEARLY, deliberately: it is the cheaper per-month number and the
// one we want anchored in someone's head, and it is what Claude, Hostinger and
// most SaaS pricing pages do.
//
// A yearly plan is quoted PER MONTH ("₹1,250 /month, billed annually") because
// that is the number a buyer compares against a competitor's monthly price.
// The full amount they will actually be charged is stated on the same card —
// quoting only the per-month figure and surprising someone at checkout is the
// oldest trick on a pricing page and we are not doing it.
//
// Prices arrive resolved from the server (lib/plans/pricing.ts): code defaults
// with any operator override folded in. This component never computes a price,
// so it cannot disagree with what billing charges.
// ---------------------------------------------------------------------------

export interface PricingCard {
  id: string;
  name: string;
  who: string;
  features: string[];
  cta: string;
  popular: boolean;
  monthlyInr: number;
  yearlyInr: number;
  /** Struck-through list price, or null when no offer is running. */
  baseMonthlyInr: number | null;
  baseYearlyInr: number | null;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function PricingCards({ plans }: { plans: PricingCard[] }) {
  const [yearly, setYearly] = useState(true);

  // Only worth showing the switch if something actually differs. On an
  // all-free catalogue a toggle that changes nothing is just a control that
  // makes people wonder what they missed.
  const hasPaid = plans.some((p) => p.monthlyInr > 0 || p.yearlyInr > 0);

  return (
    <>
      {hasPaid && (
        <div
          className="stq-billing-switch"
          role="group"
          aria-label="Billing period"
        >
          <button
            type="button"
            onClick={() => setYearly(false)}
            aria-pressed={!yearly}
            className={!yearly ? "is-on" : undefined}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setYearly(true)}
            aria-pressed={yearly}
            className={yearly ? "is-on" : undefined}
          >
            Yearly <span>· 2 months free</span>
          </button>
        </div>
      )}

      <div className="stq-pricing">
        {plans.map((p) => {
          const free = p.monthlyInr === 0 && p.yearlyInr === 0;
          // The headline is always a MONTHLY figure — on yearly it is the
          // annual total divided by twelve, so the two tabs are comparable.
          const shown = free
            ? 0
            : yearly
              ? Math.round(p.yearlyInr / 12)
              : p.monthlyInr;
          const base = yearly ? p.baseYearlyInr : p.baseMonthlyInr;
          const shownBase =
            base === null || free
              ? null
              : yearly
                ? Math.round(base / 12)
                : base;

          return (
            <div
              className={`stq-price-card${p.popular ? " popular" : ""}`}
              key={p.id}
            >
              {p.popular && (
                <span className="stq-price-flag">Most popular</span>
              )}
              <h3>{p.name}</h3>
              <p className="who">{p.who}</p>

              <div className="stq-price">
                {shownBase !== null && (
                  <s aria-label={`Was ${inr(shownBase)} per month`}>
                    {inr(shownBase)}
                  </s>
                )}
                <b>{inr(shown)}</b>
                <sub>/month</sub>
              </div>

              {/* What they are actually charged, and when. */}
              <p className="stq-card-note">
                {free
                  ? "Free forever. No card needed."
                  : yearly
                    ? `${inr(p.yearlyInr)} billed once a year`
                    : `${inr(p.monthlyInr)} billed every month`}
              </p>

              <ul>
                {p.features.map((f) => (
                  <li key={f}>
                    <Check size={16} /> {f}
                  </li>
                ))}
              </ul>

              <Link
                href="/signup"
                className={`stq-btn ${
                  p.popular ? "stq-btn-primary" : "stq-btn-ghost"
                } stq-btn-block`}
              >
                {p.cta}
              </Link>
            </div>
          );
        })}
      </div>
    </>
  );
}
