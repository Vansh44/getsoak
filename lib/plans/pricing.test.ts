import { describe, it, expect } from "vitest";
import {
  EXTRA_LOCATION_KEY,
  defaultPricing,
  resolveExtraLocationPricing,
  resolvePricing,
  yearlyPerMonth,
} from "./pricing";
import { EXTRA_LOCATION_PRICE, PLAN_META } from "@/lib/plans";

describe("plan pricing resolution", () => {
  it("with no stored rows, is exactly the code defaults", () => {
    // An empty plan_prices table must behave as though the feature did not
    // exist — that is what makes the migration safe to deploy before any
    // operator has touched the console.
    const p = resolvePricing([]);
    expect(p).toEqual(defaultPricing());
    expect(p.pro.monthlyInr).toBe(PLAN_META.pro.monthlyInr);
    expect(p.pro.baseMonthlyInr).toBeNull();
  });

  it("a stored row overrides that plan and leaves the others alone", () => {
    const p = resolvePricing([
      {
        plan: "pro",
        monthly_inr: 2000,
        yearly_inr: 20000,
        base_monthly_inr: 5000,
        base_yearly_inr: 50000,
      },
    ]);
    expect(p.pro.monthlyInr).toBe(2000);
    expect(p.pro.baseMonthlyInr).toBe(5000);
    expect(p.basic.monthlyInr).toBe(PLAN_META.basic.monthlyInr);
  });

  it("IGNORES a row for a plan that no longer exists", () => {
    // The tier list lives in code. A stale row left by a renamed plan must not
    // conjure a fourth pricing card onto the page.
    const p = resolvePricing([
      {
        plan: "growth",
        monthly_inr: 999,
        yearly_inr: 9990,
        base_monthly_inr: null,
        base_yearly_inr: null,
      },
    ]);
    expect(Object.keys(p).sort()).toEqual(["basic", "free", "pro"]);
  });

  it("quotes a yearly plan per month", () => {
    expect(
      yearlyPerMonth({
        monthlyInr: 5000,
        yearlyInr: 50000,
        baseMonthlyInr: null,
        baseYearlyInr: null,
      }),
    ).toBe(4167);
  });

  it("yearly is ten months of the monthly price — the 'two months free' promise", () => {
    // The pricing page and the FAQ both say annual billing gives two months
    // free. If these defaults ever drift apart, that claim silently stops
    // being true and nothing else would catch it.
    for (const id of ["basic", "pro"] as const) {
      expect(PLAN_META[id].yearlyInr).toBe(PLAN_META[id].monthlyInr * 10);
    }
  });
});

// ---------------------------------------------------------------------------
// The metered POS location add-on (roadmap Step 5, plans_05).
//
// Priced through the SAME operator console as the tiers, but deliberately NOT a
// tier: the separation below is what stops it rendering as a fourth pricing
// card that someone could try to sign up to.
// ---------------------------------------------------------------------------

const ADDON_ROW = {
  plan: EXTRA_LOCATION_KEY,
  monthly_inr: 1500,
  yearly_inr: 15000,
  base_monthly_inr: null,
  base_yearly_inr: null,
};

describe("extra-location pricing", () => {
  it("with no stored row, is the code constant", () => {
    // An empty table behaves as though the feature did not exist — what makes
    // the migration safe to deploy before any operator touches the console.
    expect(resolveExtraLocationPricing([])).toEqual({
      monthlyInr: EXTRA_LOCATION_PRICE.monthlyInr,
      yearlyInr: EXTRA_LOCATION_PRICE.yearlyInr,
    });
  });

  it("a stored row overrides it", () => {
    expect(resolveExtraLocationPricing([ADDON_ROW])).toEqual({
      monthlyInr: 1500,
      yearlyInr: 15000,
    });
  });

  // ★ THE SEPARATION IS THE POINT. resolvePricing keys off PLAN_IDS, so the
  // add-on row cannot conjure a fourth card onto the public pricing page —
  // and widening resolvePricing to accept arbitrary keys is exactly what would.
  it("★ never appears in the tier map", () => {
    const p = resolvePricing([ADDON_ROW]);
    expect(p).toEqual(defaultPricing());
    expect(Object.keys(p)).not.toContain(EXTRA_LOCATION_KEY);
  });

  it("★ tiers and the add-on read from the same rows without colliding", () => {
    const rows = [
      {
        plan: "pro",
        monthly_inr: 9000,
        yearly_inr: 90000,
        base_monthly_inr: null,
        base_yearly_inr: null,
      },
      ADDON_ROW,
    ];
    expect(resolvePricing(rows).pro.monthlyInr).toBe(9000);
    expect(resolveExtraLocationPricing(rows).monthlyInr).toBe(1500);
  });
});
