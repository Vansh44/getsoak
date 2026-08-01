import { describe, it, expect } from "vitest";
import {
  canUpdateSubscription,
  decidePlanChange,
  describePlanChange,
  type PlanChangeRequest,
} from "./plan-change";

const base: PlanChangeRequest = {
  currentPlan: "basic",
  currentPeriod: "monthly",
  currentAmountPaise: 150_000, // ₹1,500
  targetPlan: "pro",
  targetPeriod: "monthly",
  targetAmountPaise: 500_000, // ₹5,000
};

describe("decidePlanChange", () => {
  it("a tier upgrade applies immediately", () => {
    const d = decidePlanChange(base);
    expect(d).toMatchObject({ kind: "change", when: "now", immediate: true });
  });

  it("a tier downgrade waits for the cycle to end", () => {
    // The whole point: applying it now means refunding the unused part of a
    // cycle already paid for.
    const d = decidePlanChange({
      ...base,
      currentPlan: "pro",
      currentAmountPaise: 500_000,
      targetPlan: "basic",
      targetAmountPaise: 150_000,
    });
    expect(d).toMatchObject({ when: "cycle_end", immediate: false });
  });

  it("monthly → yearly is an upgrade (bigger charge), so it applies now", () => {
    const d = decidePlanChange({
      currentPlan: "pro",
      currentPeriod: "monthly",
      currentAmountPaise: 500_000,
      targetPlan: "pro",
      targetPeriod: "yearly",
      targetAmountPaise: 5_000_000,
    });
    expect(d).toMatchObject({ when: "now", immediate: true });
    expect(d).toMatchObject({ periodChanged: true, planChanged: false });
  });

  it("yearly → monthly is a downgrade, so it waits", () => {
    // Never refund a prepaid year: they keep what they bought until it runs out.
    const d = decidePlanChange({
      currentPlan: "pro",
      currentPeriod: "yearly",
      currentAmountPaise: 5_000_000,
      targetPlan: "pro",
      targetPeriod: "monthly",
      targetAmountPaise: 500_000,
    });
    expect(d).toMatchObject({ when: "cycle_end", immediate: false });
  });

  it("same plan AND same period is a no-op, not a change", () => {
    const d = decidePlanChange({ ...base, targetPlan: "basic" });
    expect(d.kind).toBe("noop");
  });

  it("same plan with a DIFFERENT period is a real change", () => {
    // The old code refused this outright ("You're already on the Pro plan"),
    // which is why switching billing period was impossible.
    const d = decidePlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "yearly",
      targetAmountPaise: 1_500_000,
    });
    expect(d.kind).toBe("change");
  });

  it("an equal-cost move waits rather than charging a proration of zero", () => {
    // Razorpay rejects immediate updates whose prorated difference is under
    // ₹0.50, so 'now' would fail at the gateway anyway.
    const d = decidePlanChange({ ...base, targetAmountPaise: 150_000 });
    expect(d).toMatchObject({ when: "cycle_end", immediate: false });
  });

  it("★ judges by what the merchant PAYS, not by tier", () => {
    // A grandfathered subscriber on an old ₹1,000 Pro price moving to Basic at
    // today's ₹1,500 is a tier DOWNgrade but a real price INCREASE. Charging
    // it immediately is correct; scheduling it would give them a cheaper plan
    // at a higher price with no charge taken.
    const d = decidePlanChange({
      currentPlan: "pro",
      currentPeriod: "monthly",
      currentAmountPaise: 100_000,
      targetPlan: "basic",
      targetPeriod: "monthly",
      targetAmountPaise: 150_000,
    });
    expect(d).toMatchObject({ when: "now", immediate: true });
  });
});

describe("canUpdateSubscription", () => {
  it("allows the two states Razorpay allows", () => {
    expect(canUpdateSubscription("active").ok).toBe(true);
    expect(canUpdateSubscription("authenticated").ok).toBe(true);
  });

  it("refuses halted and pending with an explanation, not a gateway error", () => {
    // These are the states a subscription lands in after a payment FAILS —
    // exactly when someone comes here to downgrade. Razorpay rejects the
    // update, so without this they would get a raw error at the worst moment.
    for (const s of ["halted", "pending"]) {
      const r = canUpdateSubscription(s);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/payment/i);
    }
  });

  it("refuses terminal states", () => {
    for (const s of ["cancelled", "completed", "expired"]) {
      expect(canUpdateSubscription(s).ok).toBe(false);
    }
  });

  it("refuses an unknown or missing status rather than assuming it is fine", () => {
    expect(canUpdateSubscription(null).ok).toBe(false);
    expect(canUpdateSubscription("created").ok).toBe(false);
  });
});

describe("describePlanChange", () => {
  it("says money moves today only when it does", () => {
    const now = describePlanChange(
      {
        kind: "change",
        when: "now",
        immediate: true,
        periodChanged: false,
        planChanged: true,
      },
      "Pro",
      "monthly",
    );
    expect(now).toMatch(/charged the difference/i);

    const later = describePlanChange(
      {
        kind: "change",
        when: "cycle_end",
        immediate: false,
        periodChanged: false,
        planChanged: true,
      },
      "Basic",
      "monthly",
    );
    expect(later).toMatch(/nothing is charged today/i);
  });
});
