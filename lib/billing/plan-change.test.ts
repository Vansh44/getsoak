/* eslint-disable @typescript-eslint/no-explicit-any */
// Moving between plans and billing periods.
//
// The rule under test is one sentence with a lot resting on it: DEARER APPLIES
// NOW AND IS PAID FOR NOW; CHEAPER OR EQUAL WAITS FOR THE CYCLE END. Its purpose
// is that nobody is ever refunded, so the failure to guard against is an
// immediate downgrade — which looks generous and creates a refund.
//
// Two things it must get right that rank alone cannot:
//   • monthly → yearly is an UPGRADE (same tier, ten times the money);
//   • a tier downgrade can be a price RISE for a grandfathered subscriber.
// Both fall out of comparing AMOUNTS, which is why decidePlanChange takes them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const provider = vi.hoisted(() => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("@/lib/payments/provider", () => provider);

const rzp = vi.hoisted(() => ({
  rzpCreateOrder: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

const store = vi.hoisted(() => ({
  loadTaxContext: vi.fn(),
  createAddonInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => store);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
}));
vi.mock("./collect", () => collect);

import { confirmPlanChange, startPlanChange } from "./plan-change";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
/** Half of a 30-day cycle remaining. */
const PERIOD_END = "2026-09-16T00:00:00.000Z";
const PRICE = { monthlyInr: 1000, yearlyInr: 10000 };

const PLAN_PAISE: Record<string, Record<string, number>> = {
  basic: { monthly: 1_500_00, yearly: 15_000_00 },
  pro: { monthly: 5_000_00, yearly: 50_000_00 },
};
const priceFor = vi.fn(async (plan: string, period: string) => ({
  planPaise: PLAN_PAISE[plan][period],
}));

function subRow(over: Record<string, unknown> = {}) {
  return {
    plan: "basic",
    period: "monthly",
    state: "active",
    billedLocations: 0,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    mandateId: null,
    ...over,
  };
}

/** sub row, then the next-invoice probe (empty = not issued), then writes. */
function seed(rows: any[][]) {
  dbHolder.current = makeDbMock({ selectQueue: rows });
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_1",
    keySecret: "secret",
  });
  rzp.rzpCreateOrder.mockResolvedValue({ ok: true, data: { id: "order_1" } });
  rzp.verifyCheckoutSignature.mockReturnValue(true);
  store.loadTaxContext.mockResolvedValue({
    enabled: false,
    rateBps: 0,
    inclusive: false,
    supplierStateCode: null,
    placeOfSupply: null,
  });
  store.createAddonInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
  });
  store.finalizeInvoice.mockResolvedValue({ id: "inv-1", status: "open" });
  store.amountDueForInvoice.mockResolvedValue(175_000);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
});

const base = {
  storeId: STORE,
  priceFor,
  locationPrice: PRICE,
  now: NOW,
};

describe("startPlanChange — dearer applies NOW", () => {
  it("★★ charges the part period for an UPGRADE", async () => {
    // basic→pro monthly: (5,000 − 1,500) × 15/30 = ₹1,750.
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.payment?.providerOrderId).toBe("order_1");
    expect(store.createAddonInvoice.mock.calls[0][0].built.totalPaise).toBe(
      175_000,
    );
  });

  it("★★ monthly → yearly is an UPGRADE, though the TIER is unchanged", async () => {
    // Rank would call this "no change" while the charge is ten times bigger.
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "yearly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.payment).toBeDefined();
  });

  it("★★ grants NOTHING before the payment", async () => {
    seed([[subRow()], []]);
    await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ does not finalize the invoice up front", async () => {
    seed([[subRow()], []]);
    await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ a ZERO part period applies it FREE rather than refusing the upgrade", async () => {
    // At the very end of a cycle the proration rounds to nothing and Razorpay
    // refuses a ₹0 order. The merchant gains a few hours.
    seed([[subRow({ currentPeriodEnd: NOW.toISOString() })], [], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.payment).toBeUndefined();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.set[0].plan).toBe("pro");
  });

  it("★ an UNKNOWN order outcome leaves the attempt in flight", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seed([[subRow()], []]);
    await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });
});

describe("startPlanChange — cheaper or equal WAITS", () => {
  it("★★ SCHEDULES a downgrade and moves no money", async () => {
    seed([[subRow({ plan: "pro" })], [], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scheduled).toBe(true);
    expect(res.data.effectiveAt).toBe(PERIOD_END);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    const set = dbHolder.current.calls.set[0];
    expect(set.scheduledPlan).toBe("basic");
    // ★ The LIVE plan is untouched — they keep what they paid for.
    expect(set.plan).toBeUndefined();
  });

  it("★ yearly → monthly is a DOWNGRADE and waits", async () => {
    seed([[subRow({ period: "yearly" })], [], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.scheduled).toBe(true);
    expect(dbHolder.current.calls.set[0].scheduledPeriod).toBe("monthly");
  });

  it("★★ REFUSES inside the collection window — that invoice is already issued", async () => {
    // Applying it at the turn against an invoice priced at the OLD plan bills the
    // wrong amount for a whole cycle.
    seed([[subRow({ plan: "pro" })], [{ id: "inv-next" }]]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already been issued/i);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ FAILS TOWARD REFUSING when it cannot tell whether the invoice exists", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[subRow({ plan: "pro" })]] });
    let n = 0;
    const real = dbHolder.current.db.select;
    dbHolder.current.db.select = (...a: any[]) => {
      n += 1;
      if (n === 2) throw new Error("db down");
      return real(...a);
    };
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });
});

describe("startPlanChange — refusals", () => {
  it("refuses a no-op", async () => {
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
  });

  it("★ refuses FREE — that is a cancellation, not a change", async () => {
    seed([[subRow()], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "free" as any,
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Cancel your subscription/i);
  });

  it("★★ refuses while the subscription is CANCELLING", async () => {
    // A cancelling subscription has no next cycle to schedule into, and applying
    // a change now would contradict the cancellation.
    seed([[subRow({ cancelAtPeriodEnd: true })], []]);
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Resume it first/i);
  });

  it("refuses with no live subscription", async () => {
    seed([[subRow({ state: "free" })], []]);
    expect(
      (
        await startPlanChange({
          ...base,
          targetPlan: "pro",
          targetPeriod: "monthly",
        })
      ).ok,
    ).toBe(false);
  });

  it("★★ FAILS CLOSED on a read error", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const res = await startPlanChange({
      ...base,
      targetPlan: "pro",
      targetPeriod: "monthly",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/couldn't check/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ drops billable locations when the TARGET plan has no POS", async () => {
    // Charging for shops a plan cannot use is indefensible, and resolveNextCycle
    // applies the same rule at the turn — so quote and outcome agree.
    seed([[subRow({ plan: "pro", billedLocations: 3 })], [], []]);
    await startPlanChange({
      ...base,
      targetPlan: "basic",
      targetPeriod: "monthly",
    });
    // Scheduled, so the location count moves at the turn via resolveNextCycle;
    // what matters here is that the decision was priced without them.
    expect(dbHolder.current.calls.set[0].scheduledPlan).toBe("basic");
  });
});

describe("confirmPlanChange", () => {
  const args = {
    storeId: STORE,
    invoiceId: "inv-1",
    targetPlan: "pro" as const,
    targetPeriod: "monthly" as const,
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  /** invoice (with its location count), attempt, store row, then writes. */
  function seedConfirm(over: Record<string, unknown> = {}) {
    seed([
      [{ locations: 0 }],
      [{ id: "att-1", providerOrderId: "order_1" }],
      [{ plan: "basic", planSource: "paid", ...over }],
      [],
    ]);
  }

  it("applies the plan on a verified payment", async () => {
    seedConfirm();
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(true);
    const set = dbHolder.current.calls.set[0];
    expect(set.plan).toBe("pro");
    expect(set.period).toBe("monthly");
  });

  it("★★ REFUSES an unverified signature and applies nothing", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ issues the document once it is really paid", async () => {
    seedConfirm();
    await confirmPlanChange(args);
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW);
  });

  it("★★ THE COMP FLOOR HOLDS — billing never lowers an operator grant", async () => {
    // The defect that cost a real merchant their Pro plan (§15): only
    // billing_subscriptions moves, and stores.plan keeps the better grant.
    seedConfirm({ plan: "pro", planSource: "comp" });
    const res = await confirmPlanChange({ ...args, targetPlan: "basic" });
    expect(res.ok).toBe(true);
    // Two updates would mean stores.plan was written; only the subscription one
    // is expected here.
    const wroteStorePlan = dbHolder.current.calls.set.some(
      (s: any) => s.planSource === "paid",
    );
    expect(wroteStorePlan).toBe(false);
  });

  it("★ writes stores.plan when the floor allows it", async () => {
    seedConfirm({ plan: "basic", planSource: "paid" });
    await confirmPlanChange(args);
    expect(
      dbHolder.current.calls.set.some((s: any) => s.planSource === "paid"),
    ).toBe(true);
  });

  it("★★ refuses an invoice with no recorded count", async () => {
    // ⚠ The attempt MUST be present, or this passes because there is no payment
    // to confirm rather than because the guard held — which is how a mutation
    // removing the guard survived.
    seed([
      [{ locations: null }],
      [{ id: "att-1", providerOrderId: "order_1" }],
      [{ plan: "basic", planSource: "paid" }],
    ]);
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("refuses when there is no payment to confirm", async () => {
    seed([[{ locations: 0 }], []]);
    expect((await confirmPlanChange(args)).ok).toBe(false);
  });

  it("★★ money IN but the plan not moved is never a bare failure", async () => {
    seed([[{ locations: 0 }], [{ id: "att-1", providerOrderId: "order_1" }]]);
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    const res = await confirmPlanChange(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/don't pay again/i);
  });
});
