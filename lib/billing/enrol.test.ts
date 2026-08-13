/* eslint-disable @typescript-eslint/no-explicit-any */
// Enrolment — a merchant's first paid cycle.
//
// ── The risks this covers ──────────────────────────────────────────────────
//   • The plan must NOT be granted before the money lands. Grace exists for
//     renewals, where something has already been paid for; granting it up front
//     hands anyone 48 hours of Pro for abandoning a checkout.
//   • The SIGNATURE is the trust boundary. A payment id from the client proves
//     nothing on its own.
//   • BOTH places that record the plan must move, and the comp floor must hold —
//     the old confirmSubscription wrote stores.plan unconditionally and could
//     overwrite an operator's comp DOWNWARD.
//   • Money in, plan not moved, is the one outcome that must never be reported
//     as a bare failure.

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
  ensureRenewalInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => store);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
}));
vi.mock("./collect", () => collect);

import { confirmEnrolment, startEnrolment } from "./enrol";

const STORE = "store-1";
const INVOICE = "inv-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const CYCLE_END = "2026-10-01T00:00:00.000Z";

const priceFor = vi.fn(async () => ({
  planPaise: 5_000_00,
  locationPaise: 1_000_00,
}));

function seed(selects: any[][] = []) {
  dbHolder.current = makeDbMock({ selectQueue: selects });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_test_1",
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
  store.ensureRenewalInvoice.mockResolvedValue({
    id: INVOICE,
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
  });
  store.finalizeInvoice.mockResolvedValue({ id: INVOICE, status: "open" });
  store.amountDueForInvoice.mockResolvedValue(5_000_00);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
});

describe("startEnrolment", () => {
  const args = {
    storeId: STORE,
    plan: "pro" as const,
    period: "monthly" as const,
    priceFor,
    now: NOW,
  };

  it("issues the first invoice and opens a Razorpay order", async () => {
    const res = await startEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      invoiceId: INVOICE,
      providerOrderId: "order_1",
      keyId: "rzp_test_1",
      amountPaise: 5_000_00,
    });
  });

  it("★ bills cycle 1, starting NOW", async () => {
    await startEnrolment(args);
    const arg = store.ensureRenewalInvoice.mock.calls[0][0];
    expect(arg.cycleSeq).toBe(1);
    expect(arg.periodStart.toISOString()).toBe(NOW.toISOString());
    expect(arg.periodEnd.toISOString()).toBe(CYCLE_END);
  });

  it.each(["active", "past_due", "grace"])(
    "★★ refuses when the store is already on a %s cycle",
    async (state) => {
      // seedSubscription's upsert would otherwise rewrite plan/period on a LIVE
      // subscription before a rupee is paid — point the record at Pro, dismiss
      // the payment window. Changing tier mid-cycle is a prorated plan change,
      // a different operation from enrolling.
      seed([[{ state }]]);
      const res = await startEnrolment(args);
      expect(res.ok).toBe(false);
      expect(store.ensureRenewalInvoice).not.toHaveBeenCalled();
      expect(collect.beginAttempt).not.toHaveBeenCalled();
      expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    },
  );

  it.each(["free", "cancelled", "downgraded"])(
    "allows re-subscribing from %s",
    async (state) => {
      // A lapsed subscription is exactly who we want back.
      seed([[{ state }]]);
      expect((await startEnrolment(args)).ok).toBe(true);
    },
  );

  it("★ fails CLOSED when the subscription state can't be read", async () => {
    // Unable to read means unable to rule out billing the same store twice.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    const err = new Error("db down");
    dbHolder.current.db.select = () => {
      throw err;
    };
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ never bills locations on a first cycle", async () => {
    // Extra shops are bought after a plan is live, so charging for them here
    // would bill for something nobody has.
    await startEnrolment(args);
    const built = store.ensureRenewalInvoice.mock.calls[0][0].built;
    expect(built.lines.some((l: any) => l.kind === "location")).toBe(false);
    expect(built.totalPaise).toBe(5_000_00);
  });

  it("★ seeds the subscription in a state that grants NOTHING", async () => {
    await startEnrolment(args);
    const values = dbHolder.current.calls.values[0];
    expect(values.state).toBe("free");
    expect(values.currentCycleSeq).toBe(0);
    // The cycle columns stay unset until the money lands.
    expect(values.currentPeriodStart).toBeUndefined();
  });

  it("★★ does NOT finalize — an enrolment is an OFFER, not an obligation", async () => {
    // Finalizing here burned a number in the gapless GST series for a document
    // nobody ever received, and made /dashboard/plans demand payment for a plan
    // that was never granted. confirmEnrolment issues it once the money lands.
    await startEnrolment(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ RESUMES the same Razorpay order when an attempt is in flight", async () => {
    // Dismissing the modal leaves the attempt `processing` forever — nothing
    // tells us a modal was closed — so this used to be a DEAD END: every later
    // Subscribe answered "a payment is already in progress" and the merchant
    // could never subscribe at all. A Razorpay order stays payable until paid.
    collect.beginAttempt.mockResolvedValue(null);
    seed([
      [], // currentState: no subscription
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      attemptId: "att-old",
      providerOrderId: "order_old",
      amountPaise: 5_000_00,
    });
    // ★ And it must NOT open a second order at the gateway.
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ asks them to wait when the in-flight attempt has NO order to resume", async () => {
    // Two Subscribe clicks racing, caught before either reached the gateway.
    collect.beginAttempt.mockResolvedValue(null);
    seed([[], []]);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already in progress/i);
  });

  it("★ plants the idempotency key in the order notes", async () => {
    await startEnrolment(args);
    const notes = rzp.rzpCreateOrder.mock.calls[0][1].notes;
    expect(notes.sm_billing_key).toBe("key-1");
    expect(notes.invoice_id).toBe(INVOICE);
    expect(notes.store_id).toBe(STORE);
  });

  it("refuses the free plan", async () => {
    const res = await startEnrolment({ ...args, plan: "free" as any });
    expect(res.ok).toBe(false);
    expect(store.ensureRenewalInvoice).not.toHaveBeenCalled();
  });

  it("refuses with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    expect((await startEnrolment(args)).ok).toBe(false);
  });

  it("★ refuses when a payment is already in flight, without a second order", async () => {
    collect.beginAttempt.mockResolvedValue(null);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("refuses an already-paid enrolment", async () => {
    store.ensureRenewalInvoice.mockResolvedValue({
      id: INVOICE,
      status: "paid",
      finalizedAt: "x",
      invoiceRef: "SM/1",
    });
    expect((await startEnrolment(args)).ok).toBe(false);
  });

  it("★ a REJECTED order fails the attempt — nothing was created at the gateway", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "bad",
      outcome: "rejected",
    });
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "failed",
      expect.anything(),
    );
  });

  it("★★ an UNKNOWN order outcome leaves the attempt in flight, not failed", async () => {
    // The order may exist. Marking it failed would let a second attempt open.
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    await startEnrolment(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });

  it("★ never guesses the amount due", async () => {
    store.amountDueForInvoice.mockResolvedValue(null);
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });
});

describe("confirmEnrolment", () => {
  const args = {
    storeId: STORE,
    invoiceId: INVOICE,
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  /** attempt row, then subscription row, then stores row. */
  function seedConfirm(
    opts: { storePlan?: string; storeSource?: string } = {},
  ) {
    seed([
      [{ id: "att-1", state: "processing", providerOrderId: "order_1" }],
      [
        {
          plan: "pro",
          period: "monthly",
          state: "free",
          currentPeriodEnd: null,
        },
      ],
      [
        {
          plan: opts.storePlan ?? "free",
          planSource: opts.storeSource ?? "paid",
        },
      ],
    ]);
  }

  it("activates the plan on a verified payment", async () => {
    seedConfirm();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plan).toBe("pro");
    expect(res.data.periodEnd).toBe(CYCLE_END);
  });

  it("★★ ISSUES the invoice now — the number is spent on a payment that HAPPENED", async () => {
    // The gapless GST series must not be spent on an abandoned checkout, and the
    // document should be dated to the payment, not to the Subscribe click.
    seedConfirm();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).toHaveBeenCalledWith(INVOICE, NOW);
  });

  it("★ finalizes only AFTER the signature verifies", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ REFUSES an unverified signature, and settles nothing", async () => {
    // A payment id from the client proves nothing. Without the HMAC anyone
    // could post an arbitrary id and be granted a plan.
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ verifies against the order WE created, not one the client names", async () => {
    seedConfirm();
    await confirmEnrolment(args);
    expect(rzp.verifyCheckoutSignature).toHaveBeenCalledWith(
      "secret",
      "order_1",
      "pay_1",
      "sig",
    );
  });

  it("refuses when there is no payment to confirm", async () => {
    seed([[]]);
    expect((await confirmEnrolment(args)).ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ writes BOTH the subscription and stores.plan", async () => {
    seedConfirm();
    await confirmEnrolment(args);
    const sets = dbHolder.current.calls.set;
    const sub = sets.find((s: any) => s.currentCycleSeq === 1);
    const ent = sets.find((s: any) => s.planExpiresAt !== undefined);
    expect(sub).toMatchObject({ state: "active", planSource: "paid" });
    expect(sub.currentPeriodEnd).toBe(CYCLE_END);
    expect(ent).toMatchObject({ plan: "pro", planSource: "paid" });
    expect(ent.planExpiresAt).toBe(CYCLE_END);
  });

  it("★★ a COMP is a FLOOR — subscribing to a cheaper tier does not lower it", async () => {
    // The old confirmSubscription wrote stores.plan unconditionally, so a store
    // comped Pro that subscribed to Basic was dropped to Basic.
    seed([
      [{ id: "att-1", state: "processing", providerOrderId: "order_1" }],
      [
        {
          plan: "basic",
          period: "monthly",
          state: "free",
          currentPeriodEnd: null,
        },
      ],
      [{ plan: "pro", planSource: "comp" }],
    ]);
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Reported as the comped plan they keep, and stores.plan untouched.
    expect(res.data.plan).toBe("pro");
    const ent = dbHolder.current.calls.set.find(
      (s: any) => s.planExpiresAt !== undefined,
    );
    expect(ent).toBeUndefined();
  });

  it("★ the subscription still activates under a comp — they ARE paying", async () => {
    seed([
      [{ id: "att-1", state: "processing", providerOrderId: "order_1" }],
      [
        {
          plan: "basic",
          period: "monthly",
          state: "free",
          currentPeriodEnd: null,
        },
      ],
      [{ plan: "pro", planSource: "comp" }],
    ]);
    await confirmEnrolment(args);
    expect(
      dbHolder.current.calls.set.some((s: any) => s.state === "active"),
    ).toBe(true);
  });

  it("★ is idempotent — re-confirming an active subscription reports success", async () => {
    seed([
      [{ id: "att-1", state: "captured", providerOrderId: "order_1" }],
      [
        {
          plan: "pro",
          period: "monthly",
          state: "active",
          currentPeriodEnd: CYCLE_END,
        },
      ],
    ]);
    collect.settleAttempt.mockResolvedValue(null); // already terminal
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.periodEnd).toBe(CYCLE_END);
  });

  it("★ reports a NON-captured settle as an incomplete payment", async () => {
    collect.settleAttempt.mockResolvedValue("failed");
    seedConfirm();
    expect((await confirmEnrolment(args)).ok).toBe(false);
  });

  it("★★ money in but plan not moved is NEVER a bare failure", async () => {
    // The merchant has paid. The message must say so and tell them not to pay
    // again, or support cannot tell this from a declined card.
    collect.settleAttempt.mockResolvedValue("captured");
    seed([
      [{ id: "att-1", state: "processing", providerOrderId: "order_1" }],
      [], // subscription row missing — activation cannot proceed
    ]);
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/went through/i);
    expect(res.error).toMatch(/don't pay again/i);
  });

  it("records a mandate when the checkout registered one", async () => {
    seedConfirm();
    const res = await confirmEnrolment({
      ...args,
      mandate: {
        providerTokenId: "tok_1",
        method: "card",
        maxAmountPaise: 9_000_00,
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateActivated).toBe(true);
    const mandate = dbHolder.current.calls.values.find(
      (v: any) => v.providerTokenId === "tok_1",
    );
    expect(mandate).toMatchObject({ status: "active", method: "card" });
  });

  it("★ enrols fine with NO mandate — that only costs automatic renewal", async () => {
    seedConfirm();
    const res = await confirmEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateActivated).toBe(false);
    expect(res.data.plan).toBe("pro");
  });

  it("refuses with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    expect((await confirmEnrolment(args)).ok).toBe(false);
  });
});
