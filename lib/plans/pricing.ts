import "server-only";

// ---------------------------------------------------------------------------
// Resolved plan pricing: the code defaults in lib/plans.ts, overridden by what
// a platform operator has set in `plan_prices` (supabase/plans_03_pricing.sql).
//
// The same three-layer shape the settings registry uses (CODEBASE §9): code
// default ← stored override. An empty table behaves exactly like the constants,
// so nothing has to be seeded for the site to work.
//
// TWO PRICES PER PLAN, because the pricing page shows both:
//
//     ₹5,000   ₹2,000 /month
//     ‾‾‾‾‾‾   struck through, then what you pay
//
// `base` is the list price and is display-only — it is NEVER charged. `monthly`
// and `yearly` are what billing uses. When no offer is running `base` is null
// and the page renders a single price with no strike.
// ---------------------------------------------------------------------------

import { unstable_cache, revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { planPrices } from "@/drizzle/schema";
import { PLAN_IDS, PLAN_META, type Plan } from "@/lib/plans";
import { logError } from "@/lib/observability/logger";

/** Cache tag — bust it whenever an operator saves a price. */
export const PLAN_PRICING_TAG = "plan-pricing";

export interface PlanPrice {
  /** Charged monthly, in rupees. */
  monthlyInr: number;
  /** Charged for a year, in rupees (a total, not per month). */
  yearlyInr: number;
  /** Struck-through list price, or null when no offer is running. */
  baseMonthlyInr: number | null;
  baseYearlyInr: number | null;
}

export type PlanPricing = Record<Plan, PlanPrice>;

/** What the constants say, before any operator override. */
export function defaultPricing(): PlanPricing {
  return Object.fromEntries(
    PLAN_IDS.map((id) => [
      id,
      {
        monthlyInr: PLAN_META[id].monthlyInr,
        yearlyInr: PLAN_META[id].yearlyInr,
        baseMonthlyInr: null,
        baseYearlyInr: null,
      },
    ]),
  ) as PlanPricing;
}

interface PriceRow {
  plan: string;
  monthly_inr: number;
  yearly_inr: number;
  base_monthly_inr: number | null;
  base_yearly_inr: number | null;
}

/**
 * Fold stored rows onto the defaults. Pure, so the merge rule is testable
 * without a database.
 *
 * A row for an unknown plan id is IGNORED rather than added: the tier list
 * lives in code, and a stale row left behind by a renamed plan must not
 * conjure a fourth pricing card onto the page.
 */
export function resolvePricing(rows: readonly PriceRow[]): PlanPricing {
  const out = defaultPricing();
  for (const r of rows) {
    if (!(PLAN_IDS as readonly string[]).includes(r.plan)) continue;
    out[r.plan as Plan] = {
      monthlyInr: Number(r.monthly_inr),
      yearlyInr: Number(r.yearly_inr),
      baseMonthlyInr:
        r.base_monthly_inr === null ? null : Number(r.base_monthly_inr),
      baseYearlyInr:
        r.base_yearly_inr === null ? null : Number(r.base_yearly_inr),
    };
  }
  return out;
}

async function readPricing(): Promise<PlanPricing> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          plan: planPrices.plan,
          monthly_inr: planPrices.monthlyInr,
          yearly_inr: planPrices.yearlyInr,
          base_monthly_inr: planPrices.baseMonthlyInr,
          base_yearly_inr: planPrices.baseYearlyInr,
        })
        .from(planPrices),
    );
    return resolvePricing(rows as PriceRow[]);
  } catch (error) {
    // FAIL TO THE CONSTANTS. A pricing page that renders no prices — or worse,
    // a signup that cannot quote one — is a far worse outcome than showing the
    // compiled-in defaults for a few minutes. The table is an override, so its
    // absence is a valid state, not an error.
    logError("plan pricing: read failed, using code defaults", error);
    return defaultPricing();
  }
}

/**
 * Cached for the public pages. Tag-busted on save, so an operator's change is
 * visible immediately rather than after a revalidation window.
 */
export const getPlanPricing = unstable_cache(readPricing, ["plan-pricing"], {
  tags: [PLAN_PRICING_TAG],
  revalidate: 300,
});

/**
 * Uncached. Use where the number decides what someone is CHARGED — billing
 * must never quote a price from a cache that a reprice has not yet reached.
 */
export const getPlanPricingLive = readPricing;

export function bustPlanPricing() {
  // Next 16 requires the cache profile — `revalidateTag(tag)` alone no longer
  // compiles (AGENTS.md: this is a breaking-changes release).
  revalidateTag(PLAN_PRICING_TAG, "max");
}

/** Monthly-equivalent of the yearly price, for "₹1,250/month billed annually". */
export function yearlyPerMonth(p: PlanPrice): number {
  return Math.round(p.yearlyInr / 12);
}

/** Whole rupees, Indian grouping. Prices here are never fractional. */
export function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}
