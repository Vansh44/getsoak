import { describe, it, expect } from "vitest";
import { defaultPricing, resolvePricing, yearlyPerMonth } from "./pricing";
import { PLAN_META } from "@/lib/plans";

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
