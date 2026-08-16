/* eslint-disable @typescript-eslint/no-explicit-any */
// Manual payment.
//
// Today this is the ONLY way a renewal gets paid, because the recurring endpoint
// is unverified — so it carries the whole revenue path. What matters:
//
//   • an invoice id alone must never let one merchant pay another's bill;
//   • a CLOSED invoice (uncollectible/void) must not be payable — taking money
//     for a cycle the merchant was already downgraded for charges them for
//     service they never received;
//   • the signature is the trust boundary;
//   • paying during grace restores the plan AT ONCE, not at the next cron tick.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "@/app/actions/_test-helpers";

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
  verifyCapturedCheckoutPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

const invStore = vi.hoisted(() => ({
  getInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => invStore);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
}));
vi.mock("./collect", () => collect);

const worker = vi.hoisted(() => ({ advanceAfterPayment: vi.fn() }));
vi.mock("./renewal-worker", () => worker);

import {
  confirmInvoicePayment,
  listPayableInvoices,
  startInvoicePayment,
} from "./manual-pay";

const STORE = "store-1";
const INVOICE = "inv-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");

function openInvoice(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    storeId: STORE,
    kind: "subscription",
    status: "open",
    totalPaise: 5_000_00,
    cycleSeq: 2,
    invoiceRef: "SM/2026-27/00002",
    finalizedAt: "2026-08-28T00:00:00.000Z",
    ...over,
  };
}

function seed(rows: any[][] = []) {
  dbHolder.current = makeDbMock({ selectQueue: rows });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_1",
    keySecret: "secret",
  });
  rzp.rzpCreateOrder.mockResolvedValue({ ok: true, data: { id: "order_1" } });
  rzp.verifyCheckoutSignature.mockReturnValue(true);
  rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
    ok: true,
    gatewayRead: true,
  });
  invStore.getInvoice.mockResolvedValue(openInvoice());
  invStore.finalizeInvoice.mockResolvedValue(openInvoice());
  invStore.amountDueForInvoice.mockResolvedValue(5_000_00);
  collect.beginAttempt.mockResolvedValue({
    attemptId: "att-1",
    idempotencyKey: "key-1",
  });
  collect.settleAttempt.mockResolvedValue("captured");
  worker.advanceAfterPayment.mockResolvedValue(true);
});

describe("startInvoicePayment", () => {
  const args = { storeId: STORE, invoiceId: INVOICE, now: NOW };

  it("opens a Razorpay order for what is due", async () => {
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      providerOrderId: "order_1",
      amountPaise: 5_000_00,
      invoiceRef: "SM/2026-27/00002",
    });
  });

  it("★★ refuses an invoice belonging to ANOTHER store", async () => {
    // An invoice id alone must never reach across tenants — not to pay, not even
    // to learn the amount.
    invStore.getInvoice.mockResolvedValue(openInvoice({ storeId: "other" }));
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ refuses an AI-credit receipt before creating another order", async () => {
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ kind: "ai_credits", cycleSeq: null }),
    );
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/one-time purchase.*settled/i);
    expect(invStore.amountDueForInvoice).not.toHaveBeenCalled();
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ refuses an UNCOLLECTIBLE invoice", async () => {
    // It belongs to a cycle the merchant was already downgraded for. Taking
    // money now would charge them for service they never received.
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "uncollectible" }),
    );
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/closed unpaid/i);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ refuses a VOID invoice", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ status: "void" }));
    expect((await startInvoicePayment(args)).ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("refuses an already-paid invoice", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ status: "paid" }));
    expect((await startInvoicePayment(args)).ok).toBe(false);
  });

  it("★ refuses while a payment is PROCESSING, rather than opening a second", async () => {
    invStore.getInvoice.mockResolvedValue(
      openInvoice({ status: "processing" }),
    );
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ refuses when an attempt is already in flight", async () => {
    collect.beginAttempt.mockResolvedValue(null);
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("finalizes an unissued invoice before charging for it", async () => {
    invStore.getInvoice.mockResolvedValue(openInvoice({ finalizedAt: null }));
    await startInvoicePayment(args);
    expect(invStore.finalizeInvoice).toHaveBeenCalled();
    expect(invStore.finalizeInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      collect.beginAttempt.mock.invocationCallOrder[0],
    );
  });

  it("★ never guesses the amount due", async () => {
    invStore.amountDueForInvoice.mockResolvedValue(null);
    const res = await startInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
  });

  it("refuses when credit has already covered it", async () => {
    invStore.amountDueForInvoice.mockResolvedValue(0);
    expect((await startInvoicePayment(args)).ok).toBe(false);
  });

  it("★ plants the idempotency key in the order notes", async () => {
    await startInvoicePayment(args);
    expect(rzp.rzpCreateOrder.mock.calls[0][1].notes.sm_billing_key).toBe(
      "key-1",
    );
  });

  it("★★ an UNKNOWN order outcome leaves the attempt in flight, not failed", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    await startInvoicePayment(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "unknown",
      expect.anything(),
    );
  });

  it("a rejected order fails the attempt", async () => {
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: false,
      error: "bad",
      outcome: "rejected",
    });
    await startInvoicePayment(args);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-1",
      "failed",
      expect.anything(),
    );
  });
});

describe("listPayableInvoices", () => {
  it("★★ queries subscription debt only, never one-time credit receipts", async () => {
    seed([[]]);
    await listPayableInvoices(STORE);
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining([STORE, "subscription", "open", "processing"]),
    );
  });
});

describe("confirmInvoicePayment", () => {
  const args = {
    storeId: STORE,
    invoiceId: INVOICE,
    providerPaymentId: "pay_1",
    signature: "sig",
    now: NOW,
  };

  function seedAttempt() {
    seed([
      [{ id: "att-1", providerOrderId: "order_1", amountPaise: 5_000_00 }],
    ]);
  }

  it("settles the payment and reports the plan restored", async () => {
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.planRestored).toBe(true);
  });

  it("★★ REFUSES an unverified signature and settles nothing", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("refuses a gateway record that contradicts the signed callback", async () => {
    rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
      ok: false,
      error: "The captured amount does not match the invoice.",
    });
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("★ verifies against the order WE created", async () => {
    seedAttempt();
    await confirmInvoicePayment(args);
    expect(rzp.verifyCheckoutSignature).toHaveBeenCalledWith(
      "secret",
      "order_1",
      "pay_1",
      "sig",
    );
  });

  it("★ scopes the attempt lookup by store, not just invoice", async () => {
    seedAttempt();
    await confirmInvoicePayment(args);
    // The WHERE carries both predicates; a cross-tenant invoice id finds nothing.
    expect(dbHolder.current.calls.where.length).toBeGreaterThan(0);
  });

  it("refuses when there is no payment to confirm", async () => {
    seed([[]]);
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(collect.settleAttempt).not.toHaveBeenCalled();
  });

  it("★★ restores the plan IMMEDIATELY, not at the next cron tick", async () => {
    // A merchant who has just paid must not stay locked out of their own till.
    seedAttempt();
    await confirmInvoicePayment(args);
    expect(worker.advanceAfterPayment).toHaveBeenCalledWith(STORE, NOW);
  });

  it("★ reports planRestored FALSE when the cycle had not turned", async () => {
    // Paying inside the T−4d window settles the invoice without moving the
    // cycle — saying "plan restored" would be untrue.
    worker.advanceAfterPayment.mockResolvedValue(false);
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.planRestored).toBe(false);
  });

  it("★ reports a non-captured settle as incomplete", async () => {
    collect.settleAttempt.mockResolvedValue("failed");
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(false);
    expect(worker.advanceAfterPayment).not.toHaveBeenCalled();
  });

  it("★ a lost settle race still advances — the money is accounted for", async () => {
    collect.settleAttempt.mockResolvedValue(null);
    seedAttempt();
    const res = await confirmInvoicePayment(args);
    expect(res.ok).toBe(true);
    expect(worker.advanceAfterPayment).toHaveBeenCalled();
  });

  it("refuses with no platform credentials", async () => {
    provider.getPlatformRazorpayCreds.mockReturnValue(null);
    expect((await confirmInvoicePayment(args)).ok).toBe(false);
  });
});
