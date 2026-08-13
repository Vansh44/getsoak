// What applies NEXT cycle.
//
// This is one function because three callers days apart must agree: pass 1 PRICES
// the next invoice at T−4d, pass 2 WRITES the new shape at T0, and the plans page
// TELLS the merchant. If pricing and writing disagree, someone is billed for
// something they did not get — silently, a month later.

import { describe, it, expect } from "vitest";
import { resolveNextCycle, type ScheduledFields } from "./next-cycle";

function row(over: Partial<ScheduledFields> = {}): ScheduledFields {
  return {
    plan: "pro",
    period: "monthly",
    billedLocations: 2,
    scheduledPlan: null,
    scheduledPeriod: null,
    scheduledLocations: null,
    cancelAtPeriodEnd: false,
    ...over,
  };
}

describe("resolveNextCycle", () => {
  it("with nothing booked, the next cycle is the same as this one", () => {
    expect(resolveNextCycle(row())).toEqual({
      ending: false,
      plan: "pro",
      period: "monthly",
      billedLocations: 2,
      changed: false,
    });
  });

  it("applies a booked plan change", () => {
    const n = resolveNextCycle(row({ scheduledPlan: "basic" }));
    expect(n.plan).toBe("basic");
    expect(n.changed).toBe(true);
  });

  it("★ applies a booked PERIOD change on its own", () => {
    // The old system could not express this — same tier, different period — and
    // it changes the cycle LENGTH as well as the amount.
    const n = resolveNextCycle(row({ scheduledPeriod: "yearly" }));
    expect(n.period).toBe("yearly");
    expect(n.plan).toBe("pro");
    expect(n.changed).toBe(true);
  });

  it("applies a booked location release", () => {
    expect(resolveNextCycle(row({ scheduledLocations: 0 }))).toMatchObject({
      billedLocations: 0,
      changed: true,
    });
  });

  it("★ a release to the SAME count is not a change", () => {
    expect(resolveNextCycle(row({ scheduledLocations: 2 })).changed).toBe(
      false,
    );
  });

  describe("★★ cancellation wins over everything", () => {
    it("reports `ending` rather than a renewal", () => {
      const n = resolveNextCycle(row({ cancelAtPeriodEnd: true }));
      expect(n.ending).toBe(true);
    });

    it("★★ IGNORES a booked downgrade — they cancelled, they did not downgrade", () => {
      // Applying it instead would renew them onto a cheaper plan they explicitly
      // stopped paying for.
      const n = resolveNextCycle(
        row({ cancelAtPeriodEnd: true, scheduledPlan: "basic" }),
      );
      expect(n.ending).toBe(true);
      expect(n.plan).toBe("pro"); // unchanged; there is no next cycle to be on
    });

    it("★ ignores a booked period change too", () => {
      const n = resolveNextCycle(
        row({ cancelAtPeriodEnd: true, scheduledPeriod: "yearly" }),
      );
      expect(n.ending).toBe(true);
      expect(n.period).toBe("monthly");
    });
  });

  describe("★★ a plan with no POS carries no billable locations", () => {
    it("zeroes them when downgrading off Pro", () => {
      // Renewing a merchant onto Basic while still charging for shops it cannot
      // use is indefensible — and deciding it HERE is what stops the invoice and
      // the write from disagreeing.
      const n = resolveNextCycle(
        row({ plan: "pro", billedLocations: 3, scheduledPlan: "basic" }),
      );
      expect(n.plan).toBe("basic");
      expect(n.billedLocations).toBe(0);
      expect(n.changed).toBe(true);
    });

    it("keeps them on a plan that HAS POS", () => {
      expect(
        resolveNextCycle(row({ plan: "pro", billedLocations: 3 }))
          .billedLocations,
      ).toBe(3);
    });

    it("★ zeroes them even when the release booked MORE than zero", () => {
      // The scheduled count is what they asked for; the plan is what decides
      // whether any of it is billable.
      const n = resolveNextCycle(
        row({
          billedLocations: 5,
          scheduledPlan: "basic",
          scheduledLocations: 3,
        }),
      );
      expect(n.billedLocations).toBe(0);
    });
  });

  it("★ an unrecognised period resolves to monthly, never to junk", () => {
    expect(resolveNextCycle(row({ period: "weekly" })).period).toBe("monthly");
    expect(resolveNextCycle(row({ scheduledPeriod: "daily" })).period).toBe(
      "monthly",
    );
  });
});
