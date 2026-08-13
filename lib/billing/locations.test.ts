/* eslint-disable @typescript-eslint/no-explicit-any */
// Buying and releasing extra locations.
//
// Two things carry the weight here, and they pull in opposite directions:
//
//   • BUYING takes money, so the count must be absolute (never a delta), the
//     granted number must come from the INVOICE rather than the request, and the
//     mandate ceiling must be checked BEFORE the sale — selling a location that
//     makes the next renewal undebitable downgrades a paying merchant.
//   • RELEASING takes none, and must never take effect early: dropping the count
//     while the merchant is still paying for the shop refuses them a location
//     they own.
//
// The subtle one is the interaction: a release booked after the next invoice has
// been issued would be applied at the turn against an invoice priced at the OLD
// count — a full extra cycle charged for a shop that is gone.

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
  loadInvoiceParties: vi.fn(),
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

import {
  confirmLocationPurchase,
  getLocationBillingState,
  releaseLocations,
  startLocationPurchase,
} from "./locations";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
/** 15 days left of a 30-day cycle — exactly half. */
const PERIOD_END = "2026-09-16T00:00:00.000Z";
const PRO = { plan: "pro", plan_expires_at: null };
const PRICE = { monthlyInr: 1000, yearlyInr: 10000 };

function subRow(over: Record<string, unknown> = {}) {
  return {
    plan: "pro",
    period: "monthly",
    state: "active",
    billedLocations: 1,
    scheduledLocations: null,
    currentCycleSeq: 3,
    currentPeriodEnd: PERIOD_END,
    mandateId: null,
    ...over,
  };
}

/** sub row, then location count, then whatever the path reads next. */
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
  store.loadInvoiceParties.mockResolvedValue({
    supplierGstin: null,
    customerGstin: null,
    placeOfSupply: null,
  });
  store.createAddonInvoice.mockResolvedValue({
    id: "inv-1",
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
  });
  store.finalizeInvoice.mockResolvedValue({ id: "inv-1", status: "open" });
  store.amountDueForInvoice.mockResolvedValue(50_000);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
});

describe("getLocationBillingState", () => {
  it("reports the allowance and what one more costs part-period", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s).toMatchObject({
      included: 2,
      billed: 1,
      existing: 2,
      allowance: 3,
      period: "monthly",
      canBuy: true,
    });
    // Half a 30-day cycle left of a ₹1,000 location.
    expect(s?.nextPurchaseInr).toBe(500);
  });

  it("★ explains WHY buying is unavailable rather than hiding the control", async () => {
    seed([[null], [{ n: 1 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s?.canBuy).toBe(false);
    expect(s?.blockedReason).toMatch(/subscri/i);
  });

  it("★ a non-Pro plan is told it is a Pro feature", async () => {
    seed([[subRow()], [{ n: 1 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: { plan: "basic", plan_expires_at: null },
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s?.canBuy).toBe(false);
    expect(s?.blockedReason).toMatch(/Pro/);
  });

  it("★ surfaces a booked release", async () => {
    seed([[subRow({ billedLocations: 2, scheduledLocations: 1 })], [{ n: 3 }]]);
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s?.scheduled).toBe(1);
  });

  it("★ returns NULL on a read failure, so the page can say nothing rather than lie", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const s = await getLocationBillingState({
      storeId: STORE,
      store: PRO,
      locationPrice: PRICE,
      now: NOW,
    });
    expect(s).toBeNull();
  });
});

describe("startLocationPurchase", () => {
  const args = {
    storeId: STORE,
    store: PRO,
    requested: 2,
    locationPrice: PRICE,
    now: NOW,
  };

  it("prices the part period and opens an order", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      providerOrderId: "order_1",
      targetCount: 2,
    });
    // ₹1,000 × 15/30 = ₹500 = 50,000 paise.
    expect(store.createAddonInvoice.mock.calls[0][0].built.totalPaise).toBe(
      50_000,
    );
  });

  it("★★ records the TARGET COUNT on the invoice, not in the request", async () => {
    // confirm is a public action; reading the count from the client would let a
    // caller be granted more locations than it paid for.
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    expect(store.createAddonInvoice.mock.calls[0][0].targetCount).toBe(2);
  });

  it("★★ does NOT finalize — an unpaid addon must not burn a GST number", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ grants NOTHING before payment", async () => {
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    // No write to billing_subscriptions on the start path.
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ refuses a RELEASE routed through the buy flow, and WRITES NOTHING", async () => {
    // Charging for a reduction is the worst confusion of the two — but the real
    // hazard is quieter: a reduction prorates to ₹0, so without this guard it
    // falls into the zero-amount branch and is applied IMMEDIATELY, bypassing the
    // scheduling that stops a merchant losing a shop they are still paying for.
    // Asserting only "no order was created" does not catch that.
    seed([[subRow({ billedLocations: 3 })], [{ n: 2 }], []]);
    const res = await startLocationPurchase({ ...args, requested: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/release flow/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ refuses when it is already that number — an absolute count is idempotent", async () => {
    seed([[subRow({ billedLocations: 2 })], [{ n: 2 }]]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ refuses a store with no live subscription", async () => {
    seed([[subRow({ state: "free" })], [{ n: 2 }]]);
    expect((await startLocationPurchase(args)).ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ FAILS CLOSED on a read error", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/couldn't check/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ a ZERO part period grants it instead of charging ₹0", async () => {
    // At the very end of a cycle the proration rounds to nothing, and Razorpay
    // refuses a ₹0 order. The merchant gains a few hours; the next renewal bills
    // it in full.
    seed([
      [subRow({ currentPeriodEnd: NOW.toISOString() })],
      [{ n: 2 }],
      [], // the write
    ]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/next renewal/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    // It WAS granted.
    expect(dbHolder.current.calls.set[0].billedLocations).toBe(2);
  });

  it("★★ refuses when the next renewal would exceed the authorised mandate", async () => {
    // Razorpay would accept this and fail the DEBIT weeks later, surfacing as a
    // halted subscription rather than "you can't buy this".
    seed([
      [subRow({ mandateId: "mand-1" })],
      [{ n: 2 }],
      [{ maxAmountPaise: 100_00 }], // ₹100 ceiling, target is ₹2,000
    ]);
    const res = await startLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autopay limit/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ a comfortable ceiling does not block the sale", async () => {
    seed([
      [subRow({ mandateId: "mand-1" })],
      [{ n: 2 }],
      [{ maxAmountPaise: 50_000_00 }],
    ]);
    expect((await startLocationPurchase(args)).ok).toBe(true);
  });

  it("★ NO mandate means manual renewal, which has no ceiling — silent, not refused", async () => {
    seed([[subRow({ mandateId: null })], [{ n: 2 }]]);
    expect((await startLocationPurchase(args)).ok).toBe(true);
  });

  it("★ an UNKNOWN order outcome leaves the attempt in flight, not failed", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seed([[subRow()], [{ n: 2 }]]);
    await startLocationPurchase(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });
});

describe("confirmLocationPurchase", () => {
  const args = {
    storeId: STORE,
    invoiceId: "inv-1",
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  /** invoice (with its target), then the attempt, then the write. */
  function seedConfirm(target: number | null = 2) {
    seed([[{ target }], [{ id: "att-1", providerOrderId: "order_1" }], []]);
  }

  it("grants the count recorded on the invoice", async () => {
    seedConfirm(2);
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.billedLocations).toBe(2);
    expect(dbHolder.current.calls.set[0].billedLocations).toBe(2);
  });

  it("★★ REFUSES an unverified signature and grants nothing", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ verifies against the order WE created", async () => {
    seedConfirm();
    await confirmLocationPurchase(args);
    expect(rzp.verifyCheckoutSignature).toHaveBeenCalledWith(
      "secret",
      "order_1",
      "pay_1",
      "sig",
    );
  });

  it("★ issues the document only once it has really been paid", async () => {
    seedConfirm();
    await confirmLocationPurchase(args);
    expect(store.finalizeInvoice).toHaveBeenCalledWith("inv-1", NOW);
  });

  it("★ refuses an invoice with no recorded target", async () => {
    seedConfirm(null);
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★ refuses when there is no payment to confirm", async () => {
    seed([[{ target: 2 }], []]);
    expect((await confirmLocationPurchase(args)).ok).toBe(false);
  });

  it("★★ money IN but the grant failed is never a bare failure", async () => {
    seed([[{ target: 2 }], [{ id: "att-1", providerOrderId: "order_1" }]]);
    dbHolder.current.db.update = () => {
      throw new Error("db down");
    };
    const res = await confirmLocationPurchase(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/don't pay again/i);
  });

  it("★ clears any booked release — buying means they want the shops", async () => {
    seedConfirm(2);
    await confirmLocationPurchase(args);
    expect(dbHolder.current.calls.set[0].scheduledLocations).toBeNull();
  });
});

describe("releaseLocations", () => {
  const args = { storeId: STORE, store: PRO, requested: 0, now: NOW };

  /** sub, location count, then the next-invoice probe (empty = not issued). */
  function seedRelease(sub = subRow(), locations = 2) {
    seed([[sub], [{ n: locations }], [], []]);
  }

  it("★★ SCHEDULES it — never immediate, and never refunded", async () => {
    seedRelease(subRow({ billedLocations: 1 }), 2);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(true);
    // The LIVE count is untouched; only the schedule moves.
    const set = dbHolder.current.calls.set[0];
    expect(set.scheduledLocations).toBe(0);
    expect(set.billedLocations).toBeUndefined();
  });

  it("★ reports when it takes effect", async () => {
    seedRelease(subRow({ billedLocations: 1 }), 2);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.effectiveAt).toBe(PERIOD_END);
  });

  it("★ cancels a booked release when asked for the current count", async () => {
    seedRelease(subRow({ billedLocations: 2, scheduledLocations: 1 }), 2);
    const res = await releaseLocations({ ...args, requested: 2 });
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.set[0].scheduledLocations).toBeNull();
  });

  it("★★ REFUSES inside the collection window, because that invoice is issued", async () => {
    // Applying it at the turn against an invoice priced at the OLD count charges
    // a full extra cycle for a shop that is gone.
    seed([
      [subRow({ billedLocations: 1 })],
      [{ n: 2 }],
      [{ id: "inv-next" }], // the next cycle's invoice already exists
    ]);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already been issued/i);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ FAILS TOWARD REFUSING when it cannot tell whether the invoice exists", async () => {
    seed([[subRow({ billedLocations: 1 })], [{ n: 2 }]]);
    let calls = 0;
    const realSelect = dbHolder.current.db.select;
    dbHolder.current.db.select = (...a: any[]) => {
      calls += 1;
      if (calls === 3) throw new Error("db down");
      return realSelect(...a);
    };
    const res = await releaseLocations(args);
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★ refuses releasing below what is IN USE", async () => {
    // Soft-on-downgrade: never delete a merchant's shop on their behalf.
    seedRelease(subRow({ billedLocations: 2 }), 4);
    const res = await releaseLocations(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/using/i);
  });

  it("★ refuses an increase routed through the release flow", async () => {
    seedRelease(subRow({ billedLocations: 1 }), 2);
    const res = await releaseLocations({ ...args, requested: 3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/buy flow/i);
  });
});
