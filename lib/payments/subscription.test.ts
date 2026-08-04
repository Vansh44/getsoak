/* eslint-disable @typescript-eslint/no-explicit-any */
// Recurring billing — resolving what a merchant is actually charged.
//
// ── Why this file is exhaustive ────────────────────────────────────────────
// Nothing here moves money directly, but everything here DECIDES money: the
// amount that reaches a Razorpay plan, the ceiling authorised on a mandate,
// and the price a plan CHANGE is compared against. Two of those have failure
// modes you cannot undo after the fact —
//
//   • a stale amount mints a plan at the wrong price and every future cycle
//     bills it, silently, until someone reads a statement; and
//   • `amountForRzpPlan` returning the catalog price instead of the
//     grandfathered one makes a real INCREASE read as a decrease, so
//     decidePlanChange schedules it for the cycle end instead of charging it.
//
// ⚠ WHAT THIS CANNOT COVER. Razorpay is stubbed, so nothing proves a plan is
// really created at that price. The (plan, period, amount_paise) unique index
// behind the cache is a DB constraint and is not exercised here either — only
// that the upsert targets it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("./provider", () => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("./razorpay", () => ({ rzpCreatePlan: vi.fn() }));
vi.mock("@/lib/plans/pricing", () => ({ getPlanPricingLive: vi.fn() }));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import { getPlatformRazorpayCreds } from "./provider";
import { rzpCreatePlan } from "./razorpay";
import { getPlanPricingLive } from "@/lib/plans/pricing";
import { logError } from "@/lib/observability/logger";
import {
  amountForRzpPlan,
  mandateMaxPaise,
  planAmountPaise,
  planForRzpPlan,
  resolveRazorpayPlanId,
  totalCyclesFor,
} from "./subscription";

const CREDS = { keyId: "rzp_live_platform", keySecret: "s" };

/** Live pricing, as the pricing table reports it. */
const PRICING = {
  free: { monthlyInr: 0, yearlyInr: 0 },
  basic: { monthlyInr: 1500, yearlyInr: 15000 },
  pro: { monthlyInr: 4000, yearlyInr: 40000 },
};

function seed(selects: any[][] = [[]]) {
  dbHolder.current = makeDbMock({ selectQueue: selects });
}

/** A db whose reads and writes both reject. */
function brokenDb() {
  dbHolder.current = {
    db: {
      select: () => {
        throw new Error("connection reset");
      },
      insert: () => {
        throw new Error("connection reset");
      },
    },
    calls: { select: [], insert: [], values: [], onConflict: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPlatformRazorpayCreds).mockReturnValue(CREDS as any);
  vi.mocked(getPlanPricingLive).mockResolvedValue(PRICING as any);
  vi.mocked(rzpCreatePlan).mockResolvedValue({
    ok: true,
    data: { id: "plan_created", period: "monthly", interval: 1 },
  } as any);
  seed();
});

// ---------------------------------------------------------------------------
// planAmountPaise
// ---------------------------------------------------------------------------

describe("planAmountPaise", () => {
  it.each([
    ["basic", "monthly", 150000],
    ["basic", "yearly", 1500000],
    ["pro", "monthly", 400000],
    ["pro", "yearly", 4000000],
  ] as const)("prices %s %s in paise", async (plan, period, expected) => {
    expect(await planAmountPaise(plan, period)).toBe(expected);
  });

  it("★ reads LIVE pricing, never the catalog", async () => {
    // This number decides what someone is billed. Quoting from a cache a
    // reprice hasn't reached yet would charge the old amount, and the merchant
    // would see one price on the page and another on their statement.
    vi.mocked(getPlanPricingLive).mockResolvedValue({
      ...PRICING,
      pro: { monthlyInr: 5000, yearlyInr: 50000 },
    } as any);
    expect(await planAmountPaise("pro", "monthly")).toBe(500000);
    expect(getPlanPricingLive).toHaveBeenCalled();
  });

  it("prices the free plan at nothing", async () => {
    expect(await planAmountPaise("free", "monthly")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// totalCyclesFor
// ---------------------------------------------------------------------------

describe("totalCyclesFor", () => {
  it("★ asks for ten years either way — 'until cancelled'", async () => {
    // Razorpay requires a finite count up front, so both are set far enough
    // out that the subscription ends when the merchant ends it, not when the
    // count runs out. 120 monthly and 10 yearly are the same decade.
    expect(totalCyclesFor("monthly")).toBe(120);
    expect(totalCyclesFor("yearly")).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// mandateMaxPaise
// ---------------------------------------------------------------------------

describe("mandateMaxPaise", () => {
  it("★ authorises DOUBLE the top yearly price", async () => {
    // A mandate ceiling is fixed when authorised and can only be raised by
    // re-authorising. Pinning it to today's top price means the next price
    // rise locks existing subscribers out of upgrading, with "cancel and
    // subscribe again" as the only route. A ceiling is not a charge.
    expect(await mandateMaxPaise()).toBe(4000000 * 2);
  });

  it("moves with a reprice", async () => {
    vi.mocked(getPlanPricingLive).mockResolvedValue({
      ...PRICING,
      pro: { monthlyInr: 5000, yearlyInr: 60000 },
    } as any);
    expect(await mandateMaxPaise()).toBe(6000000 * 2);
  });
});

// ---------------------------------------------------------------------------
// resolveRazorpayPlanId
// ---------------------------------------------------------------------------

describe("resolveRazorpayPlanId", () => {
  it("returns a cached plan without calling Razorpay", async () => {
    seed([[{ rzp_plan_id: "plan_cached" }]]);
    expect(await resolveRazorpayPlanId("pro", "monthly")).toEqual({
      rzpPlanId: "plan_cached",
      amountPaise: 400000,
    });
    expect(rzpCreatePlan).not.toHaveBeenCalled();
  });

  it("creates and caches one on a miss", async () => {
    const res = await resolveRazorpayPlanId("basic", "yearly");
    expect(res).toEqual({ rzpPlanId: "plan_created", amountPaise: 1500000 });
    expect(rzpCreatePlan).toHaveBeenCalledWith(CREDS, {
      period: "yearly",
      amountPaise: 1500000,
      name: "StoreMink Basic (yearly)",
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      plan: "basic",
      period: "yearly",
      amountPaise: 1500000,
      rzpPlanId: "plan_created",
    });
  });

  it("★ keys the cache on the PRICE as well as the tier", async () => {
    // A reprice must mint a NEW Razorpay plan rather than charging the stale
    // amount — which is also what grandfathers existing subscribers onto the
    // plan they authorised.
    await resolveRazorpayPlanId("pro", "monthly");
    expect(dbHolder.current.calls.onConflict[0]).toBeDefined();
    expect(dbHolder.current.calls.values[0].amountPaise).toBe(400000);
  });

  it("★ never creates a plan for the free tier", async () => {
    expect(await resolveRazorpayPlanId("free", "monthly")).toBeNull();
    expect(getPlatformRazorpayCreds).not.toHaveBeenCalled();
    expect(rzpCreatePlan).not.toHaveBeenCalled();
  });

  it("returns null when the platform account isn't configured", async () => {
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null);
    expect(await resolveRazorpayPlanId("pro", "monthly")).toBeNull();
    expect(rzpCreatePlan).not.toHaveBeenCalled();
  });

  it("★ falls through to creating one when the cache READ fails", async () => {
    // A cache is an optimisation. A DB blip must not stop a merchant
    // subscribing — the worst case is a duplicate plan at Razorpay.
    brokenDb();
    expect(await resolveRazorpayPlanId("pro", "monthly")).toEqual({
      rzpPlanId: "plan_created",
      amountPaise: 400000,
    });
  });

  it("★ still returns the plan when the cache WRITE fails", async () => {
    // The plan exists at Razorpay by this point; refusing to return it would
    // orphan what we just created and fail an upgrade that had succeeded.
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("unique violation");
    });
    expect(await resolveRazorpayPlanId("pro", "monthly")).toEqual({
      rzpPlanId: "plan_created",
      amountPaise: 400000,
    });
    expect(logError).toHaveBeenCalledWith(
      "billing.plan_cache",
      expect.any(Error),
      { plan: "pro", period: "monthly" },
    );
  });

  it("★ returns null and logs WHY when Razorpay refuses to create it", async () => {
    // The end of the road for an upgrade: the caller reports that the
    // subscription couldn't start, and the gateway's actual reason lives only
    // in this log line.
    vi.mocked(rzpCreatePlan).mockResolvedValue({
      ok: false,
      error: "The api key provided is invalid",
      outcome: "rejected",
    } as any);
    expect(await resolveRazorpayPlanId("pro", "yearly")).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "billing.plan_create",
      "The api key provided is invalid",
      { plan: "pro", period: "yearly", amountPaise: 4000000 },
    );
  });

  it("treats a cached row with no id as a miss", async () => {
    seed([[{ rzp_plan_id: null }]]);
    expect(await resolveRazorpayPlanId("pro", "monthly")).toEqual({
      rzpPlanId: "plan_created",
      amountPaise: 400000,
    });
    expect(rzpCreatePlan).toHaveBeenCalled();
  });

  it("names the plan so it is identifiable in the Razorpay dashboard", async () => {
    await resolveRazorpayPlanId("pro", "monthly");
    expect(vi.mocked(rzpCreatePlan).mock.calls[0]![1].name).toBe(
      "StoreMink Pro (monthly)",
    );
  });
});

// ---------------------------------------------------------------------------
// amountForRzpPlan
// ---------------------------------------------------------------------------

describe("amountForRzpPlan", () => {
  it("★ reports what a subscriber ACTUALLY pays, not the catalog price", async () => {
    // An existing subscriber may be grandfathered on an older, cheaper plan.
    // Comparing a change to the catalog instead would misread a real increase
    // as a decrease and SCHEDULE it for the cycle end rather than charging it
    // — the merchant gets the dearer tier now and is billed for it later.
    seed([[{ amount_paise: 250000 }]]);
    expect(await amountForRzpPlan("plan_old")).toBe(250000);
  });

  it.each([null, undefined, ""])(
    "returns null for %s without asking the DB",
    async (id) => {
      seed([[{ amount_paise: 250000 }]]);
      expect(await amountForRzpPlan(id as any)).toBeNull();
      expect(dbHolder.current.calls.select).toHaveLength(0);
    },
  );

  it("★ returns null for a plan we didn't create", async () => {
    // Made by hand in the Razorpay dashboard, or before this cache existed.
    // Null is the signal for callers to fall back to the catalog price.
    seed([[]]);
    expect(await amountForRzpPlan("plan_unknown")).toBeNull();
  });

  it("returns null when the row has no amount", async () => {
    seed([[{ amount_paise: null }]]);
    expect(await amountForRzpPlan("plan_x")).toBeNull();
  });

  it("★ returns null rather than throwing when the query fails", async () => {
    // Callers fall back to the catalog price, which is a worse answer than
    // the truth but a far better one than a crashed billing page.
    brokenDb();
    expect(await amountForRzpPlan("plan_x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planForRzpPlan
// ---------------------------------------------------------------------------

describe("planForRzpPlan", () => {
  it("★ maps an id back to BOTH axes", async () => {
    // The webhook needs the period as well as the tier: after a period change
    // the subscription's stored period is stale until it is read back from the
    // plan Razorpay is actually billing.
    seed([[{ plan: "pro", period: "yearly" }]]);
    expect(await planForRzpPlan("plan_1")).toEqual({
      plan: "pro",
      period: "yearly",
    });
  });

  it.each([null, undefined, ""])(
    "returns null for %s without asking the DB",
    async (id) => {
      seed([[{ plan: "pro", period: "yearly" }]]);
      expect(await planForRzpPlan(id as any)).toBeNull();
      expect(dbHolder.current.calls.select).toHaveLength(0);
    },
  );

  it("returns null for an unknown id", async () => {
    seed([[]]);
    expect(await planForRzpPlan("plan_unknown")).toBeNull();
  });

  it.each(["monthly", "quarterly", "", null])(
    "★ narrows a period of %s to monthly",
    async (period) => {
      // The column is free text, but the type is a union. Anything that isn't
      // exactly "yearly" bills monthly — the cheaper reading, so a corrupt row
      // can't turn a monthly subscriber into a yearly charge.
      seed([[{ plan: "basic", period }]]);
      expect((await planForRzpPlan("plan_1"))?.period).toBe("monthly");
    },
  );

  it("returns null rather than throwing when the query fails", async () => {
    brokenDb();
    expect(await planForRzpPlan("plan_x")).toBeNull();
  });
});
