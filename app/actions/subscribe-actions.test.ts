/* eslint-disable @typescript-eslint/no-explicit-any */
// Subscribing on the new billing system.
//
// Every export of a "use server" file is a publicly reachable endpoint, and
// these take money and change entitlement — so the gate on each one, and the
// guard against being billed by BOTH systems at once, are what these tests are
// for. The enrolment logic itself is proved by lib/billing/enrol.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
// The action imports STORE_TAG from resolve.ts, which builds an unstable_cache
// at module scope. Stub the module rather than widening the next/cache mock —
// the constant is all this file needs.
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));

const access = vi.hoisted(() => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => access);

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const enrol = vi.hoisted(() => ({
  startEnrolment: vi.fn(),
  confirmEnrolment: vi.fn(),
  ensureBillingAccount: vi.fn(),
  auditEnrolment: vi.fn(),
}));
vi.mock("@/lib/billing/enrol", () => enrol);

const pricing = vi.hoisted(() => ({
  getPlanPricingLive: vi.fn(),
  getExtraLocationPricingLive: vi.fn(),
}));
vi.mock("@/lib/plans/pricing", () => pricing);

const manual = vi.hoisted(() => ({
  startInvoicePayment: vi.fn(),
  confirmInvoicePayment: vi.fn(),
  listPayableInvoices: vi.fn(),
}));
vi.mock("@/lib/billing/manual-pay", () => manual);

import {
  confirmPayInvoice,
  confirmSubscribe,
  getPayableInvoices,
  startPayInvoice,
  startSubscribe,
} from "./subscribe-actions";

const STORE = "store-1";

/** No legacy subscription by default. */
function seed(rows: any[][] = [[]]) {
  dbHolder.current = makeDbMock({ selectQueue: rows });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  access.getManagerUserId.mockResolvedValue("admin-1");
  access.getActingStoreId.mockResolvedValue(STORE);
  enrol.ensureBillingAccount.mockResolvedValue(true);
  enrol.startEnrolment.mockResolvedValue({
    ok: true,
    data: {
      invoiceId: "inv-1",
      attemptId: "att-1",
      providerOrderId: "order_1",
      keyId: "rzp_1",
      amountPaise: 5_000_00,
      suggestedMandateMaxPaise: 9_000_00,
      providerCustomerId: "cust_1",
    },
  });
  enrol.confirmEnrolment.mockResolvedValue({
    ok: true,
    data: {
      plan: "pro",
      periodEnd: "2026-10-01T00:00:00.000Z",
      mandateActivated: true,
    },
  });
  pricing.getPlanPricingLive.mockResolvedValue({
    free: { monthlyInr: 0, yearlyInr: 0 },
    basic: { monthlyInr: 1500, yearlyInr: 15000 },
    pro: { monthlyInr: 5000, yearlyInr: 50000 },
  });
  pricing.getExtraLocationPricingLive.mockResolvedValue({
    monthlyInr: 1000,
    yearlyInr: 10000,
  });
  manual.startInvoicePayment.mockResolvedValue({
    ok: true,
    data: {
      invoiceId: "inv-9",
      providerOrderId: "order_9",
      keyId: "rzp_1",
      amountPaise: 5_000_00,
      invoiceRef: "SM/2026-27/00009",
    },
  });
  manual.confirmInvoicePayment.mockResolvedValue({
    ok: true,
    data: { invoiceId: "inv-9", planRestored: true },
  });
  manual.listPayableInvoices.mockResolvedValue([{ id: "inv-9" }]);
});

describe("manual payment actions", () => {
  it("★ every one is gated, and does nothing unauthorised", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    expect((await startPayInvoice("inv-9")).ok).toBe(false);
    expect((await confirmPayInvoice("inv-9", "pay_1", "sig")).ok).toBe(false);
    expect(await getPayableInvoices()).toEqual([]);
    expect(manual.startInvoicePayment).not.toHaveBeenCalled();
    expect(manual.confirmInvoicePayment).not.toHaveBeenCalled();
    expect(manual.listPayableInvoices).not.toHaveBeenCalled();
  });

  it("★★ takes the store from the SESSION, never the caller", async () => {
    // An invoice id is the only thing the client supplies; the tenant is ours.
    await startPayInvoice("inv-9");
    expect(manual.startInvoicePayment).toHaveBeenCalledWith({
      storeId: STORE,
      invoiceId: "inv-9",
    });
  });

  it("returns what the modal needs", async () => {
    const res = await startPayInvoice("inv-9");
    expect(res).toMatchObject({
      ok: true,
      providerOrderId: "order_9",
      amountPaise: 5_000_00,
    });
  });

  it("rejects a malformed invoice id without calling through", async () => {
    for (const bad of [null, "", 42, {}]) {
      expect((await startPayInvoice(bad)).ok).toBe(false);
    }
    expect(manual.startInvoicePayment).not.toHaveBeenCalled();
  });

  it("rejects malformed confirm input", async () => {
    const bad: [unknown, unknown, unknown][] = [
      [null, "pay_1", "sig"],
      ["inv-9", "", "sig"],
      ["inv-9", "pay_1", 42],
    ];
    for (const [a, b, c] of bad) {
      expect((await confirmPayInvoice(a, b, c)).ok).toBe(false);
    }
    expect(manual.confirmInvoicePayment).not.toHaveBeenCalled();
  });

  it("★ busts the store cache when a plan was restored", async () => {
    const { revalidateTag } = await import("next/cache");
    await confirmPayInvoice("inv-9", "pay_1", "sig");
    expect(revalidateTag).toHaveBeenCalled();
  });

  it("★ does NOT bust the cache when nothing changed", async () => {
    // Paying inside the T−4d window settles the invoice without moving the
    // cycle — no entitlement changed, so no reason to invalidate every store read.
    manual.confirmInvoicePayment.mockResolvedValue({
      ok: true,
      data: { invoiceId: "inv-9", planRestored: false },
    });
    const { revalidateTag } = await import("next/cache");
    const res = await confirmPayInvoice("inv-9", "pay_1", "sig");
    expect(res).toEqual({ ok: true, planRestored: false });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("passes a failure through", async () => {
    manual.confirmInvoicePayment.mockResolvedValue({
      ok: false,
      error: "bad sig",
    });
    expect(await confirmPayInvoice("inv-9", "pay_1", "sig")).toEqual({
      ok: false,
      error: "bad sig",
    });
  });
});

describe("startSubscribe — the gate", () => {
  it("★ refuses without permission, and starts nothing", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    const res = await startSubscribe("pro", "monthly");
    expect(res.ok).toBe(false);
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });

  it("refuses the free plan", async () => {
    expect((await startSubscribe("free", "monthly")).ok).toBe(false);
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });

  it("★ refuses an unknown plan rather than coercing it", async () => {
    for (const p of ["enterprise", "", null, 42, {}]) {
      expect((await startSubscribe(p, "monthly")).ok).toBe(false);
    }
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });

  it("coerces an unrecognised period to monthly rather than failing", async () => {
    await startSubscribe("pro", "weekly");
    expect(enrol.startEnrolment.mock.calls[0][0].period).toBe("monthly");
  });

  it("accepts yearly", async () => {
    await startSubscribe("pro", "yearly");
    expect(enrol.startEnrolment.mock.calls[0][0].period).toBe("yearly");
  });
});

// ⚠ The "never billed by both systems" block was DELETED with the old path
// (2026-08-13). `hasLegacySubscription` existed to stop a store being enrolled on
// the new system while `store_subscriptions` held a live Razorpay mandate — and
// with `subscription-actions.ts` gone, nothing can create one. The table remains
// as an audit trail that nothing reads.
//
// ★ If a legacy row is ever found in a live database, the fix is to cancel the
// GATEWAY subscription, not to reinstate this guard: our code no longer bills
// from that row, so the only thing that could still take money is Razorpay's own
// timer, which a guard here cannot reach.

describe("startSubscribe — pricing", () => {
  it("★ prices from the LIVE readers", async () => {
    await startSubscribe("basic", "yearly");
    const priceFor = enrol.startEnrolment.mock.calls[0][0].priceFor;
    expect(await priceFor("basic", "yearly")).toEqual({
      planPaise: 15_000_00,
      locationPaise: 10_000_00,
    });
    expect(pricing.getPlanPricingLive).toHaveBeenCalled();
  });

  it("returns what the client needs for the modal", async () => {
    const res = await startSubscribe("pro", "monthly");
    expect(res).toMatchObject({
      ok: true,
      providerOrderId: "order_1",
      keyId: "rzp_1",
      amountPaise: 5_000_00,
    });
  });

  it("passes an enrolment failure through", async () => {
    enrol.startEnrolment.mockResolvedValue({ ok: false, error: "nope" });
    const res = await startSubscribe("pro", "monthly");
    expect(res).toEqual({ ok: false, error: "nope" });
  });
});

describe("confirmSubscribe", () => {
  const ok = ["inv-1", "pay_1", "sig"] as const;

  it("★ refuses without permission, and confirms nothing", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    const res = await confirmSubscribe(...ok);
    expect(res.ok).toBe(false);
    expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
  });

  it("★ rejects malformed input without touching the gateway", async () => {
    const bad: [unknown, unknown, unknown][] = [
      [null, "pay_1", "sig"],
      ["inv-1", "", "sig"],
      ["inv-1", "pay_1", 42],
      [{}, {}, {}],
    ];
    for (const [a, b, c] of bad) {
      expect((await confirmSubscribe(a, b, c)).ok).toBe(false);
    }
    expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
  });

  it("activates and reports the plan and cycle end", async () => {
    seed([[{ plan: "free" }]]);
    const res = await confirmSubscribe(...ok);
    expect(res).toEqual({
      ok: true,
      plan: "pro",
      periodEnd: "2026-10-01T00:00:00.000Z",
      autopay: true,
    });
  });

  it("★ audits with the plan it moved FROM", async () => {
    seed([[{ plan: "basic" }]]);
    await confirmSubscribe(...ok);
    expect(enrol.auditEnrolment).toHaveBeenCalledWith(
      expect.objectContaining({ fromPlan: "basic", toPlan: "pro" }),
    );
  });

  it("★ still activates when the from-plan read fails — a worse audit row, not a refused payment", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    };
    const res = await confirmSubscribe(...ok);
    expect(res.ok).toBe(true);
    expect(enrol.auditEnrolment).toHaveBeenCalledWith(
      expect.objectContaining({ fromPlan: null }),
    );
  });

  it("★ notes manual renewal when no mandate was registered", async () => {
    enrol.confirmEnrolment.mockResolvedValue({
      ok: true,
      data: {
        plan: "basic",
        periodEnd: "2026-10-01T00:00:00.000Z",
        mandateActivated: false,
      },
    });
    seed([[{ plan: "free" }]]);
    const res = await confirmSubscribe(...ok);
    expect(res).toMatchObject({ ok: true, autopay: false });
    expect(enrol.auditEnrolment).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringMatching(/manual renewal/),
      }),
    );
  });

  it("★ does NOT audit when activation failed", async () => {
    enrol.confirmEnrolment.mockResolvedValue({ ok: false, error: "bad sig" });
    const res = await confirmSubscribe(...ok);
    expect(res).toEqual({ ok: false, error: "bad sig" });
    expect(enrol.auditEnrolment).not.toHaveBeenCalled();
  });

  it("busts the store cache so every plan gate sees the new plan", async () => {
    const { revalidateTag } = await import("next/cache");
    seed([[{ plan: "free" }]]);
    await confirmSubscribe(...ok);
    expect(revalidateTag).toHaveBeenCalled();
  });
});
