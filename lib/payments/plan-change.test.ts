import { describe, it, expect } from "vitest";
import {
  billingMayApplyPlan,
  canUpdateSubscription,
  cancelsAtCycleEnd,
  decidePlanChange,
  describePlanChange,
  hasLiveMandate,
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

describe("hasLiveMandate", () => {
  // The bug: this was "anything not cancelled/completed", so `created` counted.
  // We create the subscription at Razorpay BEFORE showing the mandate screen,
  // so closing the upgrade modal leaves a `created` row behind for good — and
  // the billing card then told a store paying nothing that autopay would renew
  // it, offered a Cancel that the gateway refused, and routed later upgrades
  // through changePlan (which Razorpay only allows on authenticated/active),
  // so one abandoned checkout disabled upgrading entirely.
  it("is false for a subscription the merchant never authorised", () => {
    expect(hasLiveMandate("created")).toBe(false);
  });

  it("is true once a mandate exists, including after a failed charge", () => {
    // `pending` and `halted` are post-failure states: the mandate is real, and
    // the merchant must still be able to cancel it.
    for (const s of ["authenticated", "active", "pending", "halted"]) {
      expect(hasLiveMandate(s), s).toBe(true);
    }
  });

  it("is false for terminal states, null and unknown ones", () => {
    for (const s of [
      "cancelled",
      "completed",
      "expired",
      "",
      null,
      undefined,
    ]) {
      expect(hasLiveMandate(s), String(s)).toBe(false);
    }
    // An allowlist, so a state Razorpay adds later reads as "no mandate" —
    // a Subscribe button rather than controls that error.
    expect(hasLiveMandate("some_future_state")).toBe(false);
  });
});

describe("cancelsAtCycleEnd", () => {
  // Razorpay refuses cancel_at_cycle_end when no cycle is running:
  // "Subscription cannot be cancelled since no billing cycle is going on".
  it("is false before the first charge, when no cycle exists", () => {
    expect(cancelsAtCycleEnd("authenticated", null)).toBe(false);
    expect(cancelsAtCycleEnd("created", null)).toBe(false);
  });

  it("is true only when active AND a cycle end is known", () => {
    expect(cancelsAtCycleEnd("active", "2026-09-01T00:00:00Z")).toBe(true);
    // Active with no current_end means we haven't seen the cycle yet; asking
    // for a cycle-end cancel would be the call the gateway rejects.
    expect(cancelsAtCycleEnd("active", null)).toBe(false);
  });

  it("is false for a paused or failed subscription", () => {
    expect(cancelsAtCycleEnd("halted", "2026-09-01T00:00:00Z")).toBe(false);
  });
});

describe("★ cancelsAtCycleEnd — an active mandate", () => {
  it("waits for the cycle end once billing is actually running", () => {
    // The merchant has paid for this cycle; cancelling immediately would take
    // away something already bought.
    expect(cancelsAtCycleEnd("active", "2026-09-01T00:00:00Z")).toBe(true);
  });

  it("★ cancels IMMEDIATELY when active but no cycle has an end", () => {
    // Razorpay refuses a cycle-end cancel when no billing cycle is going on,
    // and a cycle only starts at the first successful charge. Between
    // authorising a mandate and being billed on it there is nothing to
    // preserve, so this must fall back rather than fail.
    expect(cancelsAtCycleEnd("active", null)).toBe(false);
    expect(cancelsAtCycleEnd("active", undefined)).toBe(false);
    expect(cancelsAtCycleEnd("active", "")).toBe(false);
  });

  it("matches the status case-insensitively", () => {
    expect(cancelsAtCycleEnd("ACTIVE", "2026-09-01T00:00:00Z")).toBe(true);
  });

  it.each([null, undefined])(
    "★ treats a %s status as not-active rather than throwing",
    (status) => {
      // The status comes from a Razorpay row that may not have been fetched.
      // Cancelling immediately is the safe reading: it is what happens when
      // no cycle is running, and it can never take away a paid-for period.
      expect(cancelsAtCycleEnd(status, "2026-09-01T00:00:00Z")).toBe(false);
    },
  );
});

describe("★ describePlanChange — what changed decides the sentence", () => {
  /** The exact shape describePlanChange accepts, so no cast is needed. */
  type Decision = Parameters<typeof describePlanChange>[0];
  const change = (over: Partial<Decision> = {}): Decision => ({
    kind: "change",
    when: "cycle_end",
    immediate: false,
    periodChanged: false,
    planChanged: false,
    ...over,
  });

  it("★ names only the BILLING PERIOD when the tier is unchanged", () => {
    // "You'll move to Pro" would read as no change at all to someone who is
    // already on Pro and is only switching monthly → yearly.
    const s = describePlanChange(
      change({ periodChanged: true }),
      "Pro",
      "yearly",
    );
    expect(s).toContain("Pro billed yearly");
    expect(s).toContain("until it runs out");
  });

  it("★ names BOTH when the tier and the period move together", () => {
    const s = describePlanChange(
      change({
        periodChanged: true,
        planChanged: true,
        immediate: true,
        when: "now",
      }),
      "Pro",
      "yearly",
    );
    expect(s).toContain("Pro, billed yearly");
    expect(s).toContain("charged the difference");
  });

  it("names only the tier when the period is unchanged", () => {
    const s = describePlanChange(
      change({ planChanged: true, immediate: true, when: "now" }),
      "Pro",
      "monthly",
    );
    expect(s).toContain("move to Pro now");
    expect(s).not.toContain("billed");
  });

  it("★ promises nothing is charged today on a downgrade", () => {
    // The whole reason a cheaper move waits: no refund, no proration, no
    // dispute. The copy has to say so or the merchant expects money back.
    const s = describePlanChange(
      change({ planChanged: true }),
      "Basic",
      "monthly",
    );
    expect(s).toContain("Nothing is charged today");
  });
});

describe("billingMayApplyPlan", () => {
  it("★ a paid upgrade beats a comp — the bug this exists for", () => {
    // `echos` was comped basic, subscribed to Pro, was charged, and had all
    // three Razorpay webhooks discarded by an unconditional comp refusal. The
    // subscription row said pro; the store row said basic.
    expect(billingMayApplyPlan("basic", "comp", "pro")).toBe(true);
  });

  it("★ never lowers a comp — the protection the guard was written for", () => {
    // A store comped Pro must not be dropped to basic by a stale subscription
    // renewing underneath it.
    expect(billingMayApplyPlan("pro", "comp", "basic")).toBe(false);
    expect(billingMayApplyPlan("pro", "comp", "free")).toBe(false);
  });

  it("refuses an equal-rank comp, so an open-ended grant keeps no expiry", () => {
    // Applying it would swap an indefinite comp for a plan_expires_at tied to
    // the card — one failed charge and the expiry cron takes Pro away.
    expect(billingMayApplyPlan("pro", "comp", "pro")).toBe(false);
  });

  it("never blocks a store that isn't comped", () => {
    expect(billingMayApplyPlan("pro", "paid", "basic")).toBe(true);
    expect(billingMayApplyPlan("basic", "trial", "pro")).toBe(true);
    expect(billingMayApplyPlan("free", null, "pro")).toBe(true);
    expect(billingMayApplyPlan(null, undefined, "basic")).toBe(true);
  });

  it("treats the legacy `starter` id as basic", () => {
    // plan_events still records the pre-rename id; normalizePlan aliases it.
    expect(billingMayApplyPlan("starter", "comp", "pro")).toBe(true);
    expect(billingMayApplyPlan("starter", "comp", "starter")).toBe(false);
  });
});
