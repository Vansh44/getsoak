import { describe, it, expect } from "vitest";
import { aiWarnAt, LOW_REMAINING } from "./quota";
import { PLAN_LIMITS } from "@/lib/plans";

// A "running low" warning is only worth sending once. Since a generation moves
// the remaining count by exactly one, matching a POINT (not a band) is what
// makes that true without storing an "already warned" flag anywhere.
describe("aiWarnAt", () => {
  it("warns at the low-water mark", () => {
    expect(aiWarnAt(LOW_REMAINING)).toBe(true);
  });

  it("stays quiet on every generation after it", () => {
    for (let n = LOW_REMAINING - 1; n > 0; n--) {
      expect(aiWarnAt(n), `remaining=${n}`).toBe(false);
    }
  });

  it("stays quiet while there is plenty left", () => {
    expect(aiWarnAt(LOW_REMAINING + 1)).toBe(false);
    expect(aiWarnAt(50)).toBe(false);
  });

  it("warns again when the allowance is gone", () => {
    expect(aiWarnAt(0)).toBe(true);
  });

  // REGRESSION. The free plan's cap IS LOW_REMAINING, so its remaining count
  // goes 3 → 2 on the first generation and never equals the low-water mark.
  // With only that one trigger, the entire free tier was silently never warned.
  it("still warns a plan whose whole cap is the low-water mark", () => {
    const cap = PLAN_LIMITS.free.aiGenerationsPerMonth;
    expect(cap).toBe(LOW_REMAINING); // the condition that caused the bug

    const fired: number[] = [];
    for (let used = 1; used <= cap!; used++) {
      const remaining = cap! - used;
      if (aiWarnAt(remaining)) fired.push(remaining);
    }
    expect(fired).toEqual([0]); // exactly one warning, on the last generation
  });

  it("warns a bigger plan twice: a heads-up, then exhausted", () => {
    const cap = PLAN_LIMITS.pro.aiGenerationsPerMonth!;
    const fired: number[] = [];
    for (let used = 1; used <= cap; used++) {
      const remaining = cap - used;
      if (aiWarnAt(remaining)) fired.push(remaining);
    }
    expect(fired).toEqual([LOW_REMAINING, 0]);
  });
});
