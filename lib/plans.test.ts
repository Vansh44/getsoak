import { describe, it, expect } from "vitest";
import {
  PLAN_IDS,
  PLAN_META,
  PLAN_LIMITS,
  normalizePlan,
  effectivePlan,
  planAllows,
  limitsFor,
  EXPIRY_WARN_DAYS,
  expiryWarnWindow,
} from "./plans";

describe("normalizePlan", () => {
  it("passes known plans through and coerces junk to free", () => {
    expect(normalizePlan("free")).toBe("free");
    expect(normalizePlan("basic")).toBe("basic");
    expect(normalizePlan("pro")).toBe("pro");
    expect(normalizePlan("growth")).toBe("free"); // retired plan id
    expect(normalizePlan(null)).toBe("free");
    expect(normalizePlan(42)).toBe("free");
  });

  it("maps the retired 'starter' id to basic (rollout alias)", () => {
    expect(normalizePlan("starter")).toBe("basic");
  });
});

describe("effectivePlan (timed plans)", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");

  it("no expiry = the stored plan, indefinitely", () => {
    expect(effectivePlan({ plan: "pro", plan_expires_at: null }, now)).toBe(
      "pro",
    );
    expect(effectivePlan({ plan: "basic" }, now)).toBe("basic");
  });

  it("a future expiry keeps the plan", () => {
    expect(
      effectivePlan(
        { plan: "pro", plan_expires_at: "2026-08-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("pro");
  });

  it("a past expiry lapses to free", () => {
    expect(
      effectivePlan(
        { plan: "pro", plan_expires_at: "2026-07-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("free");
  });

  it("expiry exactly now counts as expired", () => {
    expect(
      effectivePlan(
        { plan: "basic", plan_expires_at: "2026-07-11T12:00:00.000Z" },
        now,
      ),
    ).toBe("free");
  });

  it("accepts Date objects", () => {
    expect(
      effectivePlan(
        { plan: "basic", plan_expires_at: new Date("2027-01-01") },
        now,
      ),
    ).toBe("basic");
  });

  it("an unparseable expiry fails open (treated as indefinite)", () => {
    expect(
      effectivePlan({ plan: "pro", plan_expires_at: "not-a-date" }, now),
    ).toBe("pro");
  });

  it("normalizes legacy plan ids before checking expiry", () => {
    expect(
      effectivePlan(
        { plan: "starter", plan_expires_at: "2027-01-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("basic");
    expect(
      effectivePlan(
        { plan: "starter", plan_expires_at: "2026-01-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("free");
  });
});

describe("planAllows", () => {
  it("no minPlan = available everywhere", () => {
    expect(planAllows("free")).toBe(true);
  });
  it("compares by rank", () => {
    expect(planAllows("free", "basic")).toBe(false);
    expect(planAllows("basic", "basic")).toBe(true);
    expect(planAllows("pro", "basic")).toBe(true);
    expect(planAllows("basic", "pro")).toBe(false);
  });
});

describe("catalog consistency", () => {
  it("every plan has meta and limits", () => {
    for (const id of PLAN_IDS) {
      expect(PLAN_META[id].id).toBe(id);
      expect(PLAN_LIMITS[id]).toBeDefined();
    }
  });

  it("prices match the owner-approved catalog", () => {
    expect(PLAN_META.free.monthlyInr).toBe(0);
    expect(PLAN_META.basic.monthlyInr).toBe(500);
    expect(PLAN_META.basic.yearlyInr).toBe(5000);
    expect(PLAN_META.pro.monthlyInr).toBe(1500);
    expect(PLAN_META.pro.yearlyInr).toBe(15000);
  });

  it("yearly is cheaper than 12× monthly", () => {
    for (const id of ["basic", "pro"] as const) {
      expect(PLAN_META[id].yearlyInr).toBeLessThan(
        PLAN_META[id].monthlyInr * 12,
      );
    }
  });

  it("every plan meters AI (credits top up the monthly allowance)", () => {
    expect(PLAN_LIMITS.free.aiGenerationsPerMonth).toBe(3);
    expect(PLAN_LIMITS.basic.aiGenerationsPerMonth).toBe(10);
    expect(PLAN_LIMITS.pro.aiGenerationsPerMonth).toBe(50);
  });

  it("online payments are a paid-plan feature (basic+)", () => {
    expect(PLAN_LIMITS.free.onlinePayments).toBe(false);
    expect(PLAN_LIMITS.basic.onlinePayments).toBe(true);
    expect(PLAN_LIMITS.pro.onlinePayments).toBe(true);
  });

  it("limits never shrink as plans go up", () => {
    const cap = (n: number | null) => n ?? Infinity;
    expect(cap(PLAN_LIMITS.basic.maxProducts)).toBeGreaterThan(
      cap(PLAN_LIMITS.free.maxProducts),
    );
    expect(cap(PLAN_LIMITS.pro.maxProducts)).toBeGreaterThanOrEqual(
      cap(PLAN_LIMITS.basic.maxProducts),
    );
    expect(cap(PLAN_LIMITS.pro.aiGenerationsPerMonth)).toBeGreaterThanOrEqual(
      cap(PLAN_LIMITS.basic.aiGenerationsPerMonth),
    );
  });

  it("limitsFor tolerates junk plans", () => {
    expect(limitsFor("bogus")).toEqual(PLAN_LIMITS.free);
    expect(limitsFor("pro").maxProducts).toBeNull();
  });
});

// The value of a "your plan expires soon" warning is that it arrives once per
// horizon. "≤ 7 days away" would re-send it every day for a week; the daily
// cron plus a 24-hour band gives once-only with no state to keep.
describe("expiryWarnWindow", () => {
  const now = new Date("2026-07-27T00:00:00.000Z");
  const at = (iso: string) => {
    // Which horizons would match a plan expiring at `iso`, on a run at `now`.
    return EXPIRY_WARN_DAYS.filter((days) => {
      const { from, to } = expiryWarnWindow(now, days);
      return iso > from && iso <= to;
    });
  };

  it("covers exactly 24 hours per horizon", () => {
    const w = expiryWarnWindow(now, 7);
    expect(w.from).toBe("2026-08-02T00:00:00.000Z"); // now + 6d
    expect(w.to).toBe("2026-08-03T00:00:00.000Z"); // now + 7d
  });

  it("matches a store on exactly one horizon at a time", () => {
    expect(at("2026-08-03T00:00:00.000Z")).toEqual([7]); // 7 days out
    expect(at("2026-07-28T00:00:00.000Z")).toEqual([1]); // 1 day out
  });

  it("does not warn on the days between the horizons", () => {
    expect(at("2026-07-31T12:00:00.000Z")).toEqual([]); // ~4.5 days out
    expect(at("2026-07-29T12:00:00.000Z")).toEqual([]); // ~2.5 days out
  });

  it("does not warn about a plan expiring beyond the furthest horizon", () => {
    expect(at("2026-09-01T00:00:00.000Z")).toEqual([]);
  });

  it("leaves already-expired plans to the downgrade pass", () => {
    // The window is half-open and starts in the FUTURE for the 1-day horizon,
    // so a plan that already lapsed is never picked up as a "warning".
    expect(at("2026-07-26T00:00:00.000Z")).toEqual([]);
    expect(at("2026-07-27T00:00:00.000Z")).toEqual([]); // exactly now
  });

  it("re-warns the same store as it passes each horizon in turn", () => {
    const expiry = "2026-08-03T00:00:00.000Z";
    expect(at(expiry)).toEqual([7]);
    // Six days later the same store is now one day out.
    const later = new Date("2026-08-02T00:00:00.000Z");
    const { from, to } = expiryWarnWindow(later, 1);
    expect(expiry > from && expiry <= to).toBe(true);
  });
});
