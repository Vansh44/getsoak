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

const auth = vi.hoisted(() => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => auth);

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
  confirmSignupSubscribe,
  confirmSubscribe,
  getPayableInvoices,
  startPayInvoice,
  startSignupSubscribe,
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
  auth.getServerUser.mockResolvedValue({ id: "admin-1", email: "o@acme.test" });
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

describe("★ startSubscribe — never billed by both systems", () => {
  it("★★ refuses when the OLD system has a live mandate", async () => {
    seed([[{ rzpSubscriptionId: "sub_old", status: "active" }]]);
    const res = await startSubscribe("pro", "monthly");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already has a subscription/i);
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });

  it("proceeds when the old row exists but its mandate is dead", async () => {
    seed([[{ rzpSubscriptionId: "sub_old", status: "cancelled" }]]);
    expect((await startSubscribe("pro", "monthly")).ok).toBe(true);
  });

  it("proceeds when the old row has no gateway subscription at all", async () => {
    seed([[{ rzpSubscriptionId: null, status: "created" }]]);
    expect((await startSubscribe("pro", "monthly")).ok).toBe(true);
  });

  it("★★ FAILS CLOSED when the legacy check itself errors", async () => {
    // If we cannot tell whether the old system is billing them, refusing costs
    // one merchant a retry; enrolling anyway could bill the same store twice
    // from two systems with no single place to stop it.
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    };
    const res = await startSubscribe("pro", "monthly");
    expect(res.ok).toBe(false);
    expect(enrol.startEnrolment).not.toHaveBeenCalled();
  });
});

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

// ---------------------------------------------------------------------------
// Signup — the same act, from the platform host.
// ---------------------------------------------------------------------------

describe("★★ signup enrolment", () => {
  // The wizard runs on storemink.com, where getActingStoreId() cannot resolve
  // the store that was created seconds ago — so the client passes its id, and
  // the ownership check is the ENTIRE security boundary.

  /** superadmin row for the claimed store, then no legacy subscription. */
  function seedOwner(role = "superadmin") {
    dbHolder.current = makeDbMock({ selectQueue: [[{ role }], []] });
  }

  describe("startSignupSubscribe", () => {
    it("starts the enrolment for the named store", async () => {
      seedOwner();
      const res = await startSignupSubscribe(STORE, "pro", "yearly");
      expect(res.ok).toBe(true);
      expect(enrol.startEnrolment.mock.calls[0][0]).toMatchObject({
        storeId: STORE,
        plan: "pro",
        period: "yearly",
      });
    });

    it("★★ REFUSES a store the caller does not own", async () => {
      // Without this, anyone signed in could post another store's id and buy —
      // or attach — a subscription on it.
      seedOwner("manager");
      const res = await startSignupSubscribe(
        "someone-elses-store",
        "pro",
        "monthly",
      );
      expect(res.ok).toBe(false);
      expect(enrol.startEnrolment).not.toHaveBeenCalled();
    });

    it("★ refuses when the caller has no admin row for it at all", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], []] });
      expect((await startSignupSubscribe(STORE, "pro", "monthly")).ok).toBe(
        false,
      );
      expect(enrol.startEnrolment).not.toHaveBeenCalled();
    });

    it("★ refuses when nobody is signed in", async () => {
      auth.getServerUser.mockResolvedValue(null);
      seedOwner();
      expect((await startSignupSubscribe(STORE, "pro", "monthly")).ok).toBe(
        false,
      );
      expect(enrol.startEnrolment).not.toHaveBeenCalled();
    });

    it("★★ FAILS CLOSED when the ownership read errors", async () => {
      // A database blip must refuse, never authorise.
      dbHolder.current = makeDbMock({ selectQueue: [] });
      dbHolder.current.db.select = () => {
        throw new Error("db down");
      };
      const res = await startSignupSubscribe(STORE, "pro", "monthly");
      expect(res.ok).toBe(false);
      // ⚠ Assert the REASON, not just the refusal. `hasLegacySubscription` also
      // fails closed on the same broken select, so `ok: false` alone is
      // satisfied whether or not the ownership gate held — which let a mutation
      // that returned the user id regardless of role pass this test.
      if (res.ok) return;
      expect(res.error).toMatch(/permission/i);
      expect(enrol.startEnrolment).not.toHaveBeenCalled();
    });

    it("★ refuses a non-string store id", async () => {
      seedOwner();
      expect((await startSignupSubscribe(null, "pro", "monthly")).ok).toBe(
        false,
      );
      expect((await startSignupSubscribe("", "pro", "monthly")).ok).toBe(false);
    });

    it("★ still validates the plan — a signup caller gets no shortcut", async () => {
      seedOwner();
      expect((await startSignupSubscribe(STORE, "free", "monthly")).ok).toBe(
        false,
      );
      expect(enrol.startEnrolment).not.toHaveBeenCalled();
    });

    it("★ does NOT use the host-resolved store", async () => {
      // getActingStoreId() would hand back the fallback store on the platform
      // host, which is how a signup payment lands on the wrong tenant.
      seedOwner();
      await startSignupSubscribe(STORE, "pro", "monthly");
      expect(access.getActingStoreId).not.toHaveBeenCalled();
    });
  });

  describe("confirmSignupSubscribe", () => {
    it("settles against the named store", async () => {
      seedOwner();
      const res = await confirmSignupSubscribe(STORE, "inv-1", "pay_1", "sig");
      expect(res.ok).toBe(true);
      expect(enrol.confirmEnrolment.mock.calls[0][0]).toMatchObject({
        storeId: STORE,
        invoiceId: "inv-1",
        providerPaymentId: "pay_1",
      });
    });

    it("★★ REFUSES to settle a payment against a store the caller does not own", async () => {
      seedOwner("cashier");
      const res = await confirmSignupSubscribe(STORE, "inv-1", "pay_1", "sig");
      expect(res.ok).toBe(false);
      expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
    });

    it("★ refuses a malformed payment payload", async () => {
      seedOwner();
      expect((await confirmSignupSubscribe(STORE, "inv-1", "", "sig")).ok).toBe(
        false,
      );
      expect(enrol.confirmEnrolment).not.toHaveBeenCalled();
    });
  });
});
