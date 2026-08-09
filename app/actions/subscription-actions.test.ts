/* eslint-disable @typescript-eslint/no-explicit-any */

// Metered extra POS locations (roadmap Step 5). This covers the money path:
// what is charged, when, and every refusal that has to happen BEFORE the
// gateway is told anything.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(async () => "user-1"),
  getActingStoreId: vi.fn(async () => "store-1"),
}));

vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  getCurrentStore: vi.fn(),
}));

vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/email/billing-emails", () => ({
  sendPlanChangedEmail: vi.fn(),
  sendSubscriptionPaymentFailedEmail: vi.fn(),
}));

vi.mock("@/lib/payments/provider", () => ({
  getPlatformRazorpayCreds: vi.fn(() => ({ keyId: "k", keySecret: "s" })),
}));

vi.mock("@/lib/payments/razorpay", () => ({
  rzpCreateSubscription: vi.fn(),
  rzpFetchSubscription: vi.fn(),
  rzpCancelSubscription: vi.fn(),
  rzpUpdateSubscription: vi.fn(async () => ({
    ok: true,
    data: { id: "sub_1", status: "active", current_end: null },
  })),
  verifySubscriptionSignature: vi.fn(() => true),
}));

vi.mock("@/lib/payments/subscription", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    // ₹5,000/mo pro, ₹50,000/yr — the catalog values, stated here so the
    // arithmetic below is readable.
    planAmountPaise: vi.fn(async (_p: string, period: string) =>
      period === "yearly" ? 5_000_000 : 500_000,
    ),
    amountForRzpPlan: vi.fn(async () => null),
    resolveRazorpayPlanId: vi.fn(
      async (_p: string, _period: string, n = 0) => ({
        rzpPlanId: `plan_${n}`,
        amountPaise: 0,
      }),
    ),
    mandateMaxPaise: vi.fn(async () => 20_000_000),
  };
});

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { storeSubscriptions } from "@/drizzle/schema";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { getCurrentStore } from "@/lib/store/resolve";
import { rzpUpdateSubscription } from "@/lib/payments/razorpay";
import { resolveRazorpayPlanId } from "@/lib/payments/subscription";
import { changeBilledLocations } from "./subscription-actions";

const PRO = { id: "store-1", plan: "pro", plan_expires_at: null, settings: {} };

/** An active Pro subscription paying for `billed` extra locations. */
function sub(over: Record<string, unknown> = {}) {
  return {
    rzp_subscription_id: "sub_1",
    rzp_plan_id: "plan_0",
    plan: "pro",
    period: "monthly",
    status: "active",
    mandate_max_paise: 20_000_000,
    billed_locations: 0,
    ...over,
  };
}

/** Queue: [subscription row], [location count]. */
function seed(subRow: any, locations: number) {
  dbHolder.current = makeDbMock({
    selectQueue: [subRow ? [subRow] : [], [{ n: locations }]],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getManagerUserId).mockResolvedValue("user-1" as any);
  vi.mocked(getCurrentStore).mockResolvedValue(PRO as any);
  vi.mocked(rzpUpdateSubscription).mockResolvedValue({
    ok: true,
    data: { id: "sub_1", status: "active", current_end: null },
  } as any);
  seed(sub(), 2);
});

describe("changeBilledLocations — gates", () => {
  it("refuses a caller without billing permission", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null as any);
    const r = await changeBilledLocations(1);
    expect(r.error).toMatch(/permission/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });

  // Buying folds the cost into a subscription, so there has to BE one. A comped
  // Pro store has no mandate to raise — saying so beats a gateway error.
  it("refuses when there is no subscription", async () => {
    seed(null, 2);
    const r = await changeBilledLocations(1);
    expect(r.error).toMatch(/set up autopay/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });

  // halted/pending are the states a subscription lands in AFTER a failed
  // payment — exactly when someone comes here to change something.
  it("refuses on a halted subscription, explaining why", async () => {
    seed(sub({ status: "halted" }), 2);
    const r = await changeBilledLocations(1);
    expect(r.error).toMatch(/payment didn't go through/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });

  it("refuses a no-op", async () => {
    seed(sub({ billed_locations: 1 }), 3);
    const r = await changeBilledLocations(1);
    expect(r.error).toMatch(/already/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });

  it("refuses a negative or fractional count", async () => {
    expect((await changeBilledLocations(-1)).error).toMatch(/whole number/i);
    seed(sub(), 2);
    expect((await changeBilledLocations(1.5)).error).toMatch(/whole number/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });

  // ★ The count becomes an AMOUNT debited from a live mandate. Unbounded, one
  // bad input mints a Razorpay plan for lakhs a month.
  it("refuses an absurd count", async () => {
    const r = await changeBilledLocations(999);
    expect(r.error).toMatch(/up to 50/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });

  // ★ Soft-on-downgrade: never delete a location on the merchant's behalf. So
  // releasing below what is in use is refused, not silently clamped — clamping
  // would leave them paying for a release they believed went through.
  it("refuses releasing below the locations in use", async () => {
    seed(sub({ billed_locations: 2 }), 4); // needs 2
    const r = await changeBilledLocations(0);
    expect(r.error).toMatch(/using 2 extra locations/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });

  // ★ CHECKED BEFORE THE GATEWAY. Razorpay would accept the plan change and
  // then fail the DEBIT weeks later, surfacing as a halted subscription rather
  // than as "you can't buy this".
  it("refuses when the new amount exceeds the authorised mandate", async () => {
    seed(sub({ mandate_max_paise: 550_000 }), 2); // ₹5,500 ceiling
    const r = await changeBilledLocations(1); // ₹5,000 + ₹1,000 = ₹6,000
    expect(r.error).toMatch(/autopay limit/i);
    expect(rzpUpdateSubscription).not.toHaveBeenCalled();
  });
});

describe("changeBilledLocations — when it takes effect", () => {
  // Dearer applies NOW and Razorpay prorates — the same rule a tier change
  // follows, for the same reason (no refunds, ever).
  it("buying applies immediately and charges the difference", async () => {
    const r = await changeBilledLocations(1);
    expect(r.success).toBe(true);
    expect(rzpUpdateSubscription).toHaveBeenCalledWith(
      expect.anything(),
      "sub_1",
      { planId: "plan_1", scheduleChangeAt: "now" },
    );
    expect(r.message).toMatch(/charged the difference/i);
    // The count is live, so it is written.
    expect(dbHolder.current.calls.set[0].billedLocations).toBe(1);
  });

  // Cheaper waits for the cycle they already paid for. Nobody is refunded, so
  // no refund can go wrong.
  it("releasing waits for the cycle end and charges nothing today", async () => {
    seed(sub({ billed_locations: 2, rzp_plan_id: "plan_2" }), 2); // needs 0
    const r = await changeBilledLocations(1);
    expect(r.success).toBe(true);
    expect(rzpUpdateSubscription).toHaveBeenCalledWith(
      expect.anything(),
      "sub_1",
      { planId: "plan_1", scheduleChangeAt: "cycle_end" },
    );
    expect(r.message).toMatch(/nothing is charged today/i);
  });

  // ★ A SCHEDULED RELEASE MUST NOT DROP THE ALLOWANCE YET. The merchant is
  // still paying for that location until the cycle ends; writing the lower
  // count now would refuse them a shop they have already bought.
  it("does not write the count for a scheduled release", async () => {
    seed(sub({ billed_locations: 2 }), 2);
    await changeBilledLocations(1);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("prices locations at the yearly rate on a yearly subscription", async () => {
    seed(sub({ period: "yearly" }), 2);
    const r = await changeBilledLocations(1);
    expect(r.success).toBe(true);
    expect(r.message).toMatch(/₹10,000\/year/);
  });

  it("passes the requested count through to the plan resolver", async () => {
    await changeBilledLocations(3);
    expect(resolveRazorpayPlanId).toHaveBeenCalledWith("pro", "monthly", 3);
  });
});

describe("changeBilledLocations — failures after the gateway", () => {
  it("reports a gateway refusal without claiming success", async () => {
    vi.mocked(rzpUpdateSubscription).mockResolvedValue({
      ok: false,
      error: "nope",
      outcome: "rejected",
    } as any);
    const r = await changeBilledLocations(1);
    expect(r.success).toBeUndefined();
    expect(r.error).toMatch(/couldn't update/i);
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  // ★ NEVER REPORT A BARE SUCCESS WHEN THE RECORD DIDN'T MOVE (§15b). The
  // merchant has already been charged by this point; telling them it worked
  // leaves them paying for a location the cap still refuses to let them create.
  it("says the money moved but the setup failed, and says don't retry", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[sub()], [{ n: 2 }]],
      failUpdateFor: [storeSubscriptions],
    });
    const r = await changeBilledLocations(1);
    expect(r.success).toBeUndefined();
    expect(r.error).toMatch(/payment went through/i);
    expect(r.error).toMatch(/don't try again/i);
  });
});
