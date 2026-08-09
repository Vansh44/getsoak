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
import {
  EXTRA_LOCATION_KEY,
  EXTRA_LOCATION_PRICE,
  PLAN_IDS,
  PLAN_META,
  type Plan,
} from "@/lib/plans";
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

// The key the add-on is stored under. DEFINED in lib/plans.ts, because that
// module is client-safe and the operator's Pricing panel needs it at runtime —
// this one is `server-only`. Re-exported so server callers have one import.
export { EXTRA_LOCATION_KEY };

/** What one extra POS location costs. No `base_*`: the add-on has no pricing
 *  card, so there is nothing to strike through. */
export interface ExtraLocationPricing {
  monthlyInr: number;
  yearlyInr: number;
}

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

/**
 * Fold stored rows onto the code default for the extra-location add-on.
 *
 * Separate from `resolvePricing` on purpose — see the note there. A missing
 * row means no operator has ever set a price, which is a valid state: the
 * constant in lib/plans.ts is the price until one does.
 */
export function resolveExtraLocationPricing(
  rows: readonly PriceRow[],
): ExtraLocationPricing {
  const row = rows.find((r) => r.plan === EXTRA_LOCATION_KEY);
  if (!row) return { ...EXTRA_LOCATION_PRICE };
  return {
    monthlyInr: Number(row.monthly_inr),
    yearlyInr: Number(row.yearly_inr),
  };
}

/**
 * One read for both. Returns [] on failure so every resolver above FAILS TO THE
 * CONSTANTS: a pricing page that renders nothing — or worse, a signup that
 * cannot quote a price — is a far worse outcome than showing the compiled-in
 * defaults for a few minutes. The table is an override, so its absence is a
 * valid state, not an error.
 */
async function readPriceRows(): Promise<PriceRow[]> {
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
    return rows as PriceRow[];
  } catch (error) {
    logError("plan pricing: read failed, using code defaults", error);
    return [];
  }
}

async function readPricing(): Promise<PlanPricing> {
  return resolvePricing(await readPriceRows());
}

async function readExtraLocationPricing(): Promise<ExtraLocationPricing> {
  return resolveExtraLocationPricing(await readPriceRows());
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

/** Cached, for anywhere the add-on price is only being DISPLAYED. */
export const getExtraLocationPricing = unstable_cache(
  readExtraLocationPricing,
  ["extra-location-pricing"],
  { tags: [PLAN_PRICING_TAG], revalidate: 300 },
);

/**
 * Uncached. Use wherever this number decides what someone is CHARGED — the same
 * rule `getPlanPricingLive` follows, and it matters more here: a location is
 * bought against a live mandate, so quoting from a cache a reprice has not
 * reached would debit the old amount.
 */
export const getExtraLocationPricingLive = readExtraLocationPricing;

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
