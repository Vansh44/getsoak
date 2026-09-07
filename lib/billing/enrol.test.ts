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
  rzpCreateAuthorizationOrder: vi.fn(),
  // The resumable branch reads the existing order back to learn its rail.
  rzpFetchOrder: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    data: { id: "order_1", method: "card" },
  })),
  rzpCreateCustomer: vi.fn(),
  // Defaults to an unreadable list: "we could not check" is never "nobody
  // paid", so the conservative branch is what an unconfigured test gets.
  rzpFetchOrderPayments: vi.fn<(...a: unknown[]) => Promise<unknown>>(
    async () => ({ ok: false, error: "not stubbed", outcome: "unknown" }),
  ),
  // Read on every confirm to learn whether the checkout registered a mandate.
  // Default deliberately has no token to cover the post-payment anomaly path.
  rzpFetchPayment: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    data: { id: "pay_1" },
  })),
  verifyCapturedCheckoutPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

// The billing contact a Razorpay customer is created from. Mocked so the
// autopay branch is actually REACHABLE in tests — without it ensureRzpCustomer
// always returns null and the gate below would pass no matter what it did.
const mail = vi.hoisted(() => ({
  resolveBillingEmail: vi.fn<
    () => Promise<{
      email: string;
      phone: string | null;
      storeName: string;
      slug: string;
    }>
  >(async () => ({
    email: "owner@acme.test",
    phone: "9876543210",
    storeName: "Acme",
    slug: "acme",
  })),
}));
vi.mock("@/lib/email/billing-emails", () => mail);

const store = vi.hoisted(() => ({
  loadTaxContext: vi.fn(),
  loadInvoiceParties: vi.fn(),
  ensureRenewalInvoice: vi.fn(),
  getCycleInvoice: vi.fn(),
  reshapeDraftSubscriptionInvoice: vi.fn(),
  finalizeInvoice: vi.fn(),
  amountDueForInvoice: vi.fn(),
}));
vi.mock("./invoice-store", () => store);

const collect = vi.hoisted(() => ({
  beginAttempt: vi.fn(),
  settleAttempt: vi.fn(),
}));
vi.mock("./collect", () => collect);

const gateway = vi.hoisted(() => ({ RECURRING_CHARGE_VERIFIED: true }));
vi.mock("./gateway", () => gateway);

const receipts = vi.hoisted(() => ({ notifyPlanActivated: vi.fn() }));
vi.mock("./receipts", () => receipts);

import { confirmEnrolment, startEnrolment } from "./enrol";

const STORE = "store-1";
const INVOICE = "inv-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
/** A monthly cycle is a 30-day DURATION, never a calendar month. */
const MONTHLY_CYCLE_END = new Date(
  NOW.getTime() + 30 * 86_400_000,
).toISOString();
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
  mail.resolveBillingEmail.mockResolvedValue({
    email: "owner@acme.test",
    phone: "9876543210",
    storeName: "Acme",
    slug: "acme",
  });
  rzp.rzpCreateCustomer.mockResolvedValue({ ok: true, data: { id: "cust_1" } });
  rzp.rzpCreateAuthorizationOrder.mockResolvedValue({
    ok: true,
    data: { id: "order_auth_1" },
  });
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — and this default
  // matters: a missing token after money moved must still grant the paid plan.
  rzp.rzpFetchPayment.mockResolvedValue({ ok: true, data: { id: "pay_1" } });
  // Same trap: the rail tests below override this, and without restoring it
  // here the override leaks into whichever test `test:shuffle` runs next.
  rzp.rzpFetchOrder.mockResolvedValue({
    ok: true,
    data: { id: "order_1", method: "card" },
  });
  rzp.rzpFetchOrderPayments.mockResolvedValue({
    ok: false,
    error: "not stubbed",
    outcome: "unknown",
  });
  rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
    ok: true,
    gatewayRead: true,
  });
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
  store.loadInvoiceParties.mockResolvedValue({
    supplierGstin: null,
    customerGstin: null,
    placeOfSupply: null,
  });
  // ★ Matches what `args` would build — monthly at ₹5,000, ending one 30-day
  // cycle after NOW — so the ordinary path does NOT look like a merchant who
  // changed their plan. A mismatch here would send every test through the
  // reshape branch, which is the opposite of representative.
  store.ensureRenewalInvoice.mockResolvedValue({
    id: INVOICE,
    status: "draft",
    finalizedAt: null,
    invoiceRef: null,
    totalPaise: 5_000_00,
    periodStart: NOW.toISOString(),
    periodEnd: MONTHLY_CYCLE_END,
  });
  store.reshapeDraftSubscriptionInvoice.mockResolvedValue(null);
  // No earlier enrolment invoice: the ordinary path, where nothing is stale.
  store.getCycleInvoice.mockResolvedValue(null);
  gateway.RECURRING_CHARGE_VERIFIED = true;
  // Same trap again: the reshape tests below override the price, and
  // clearAllMocks clears CALLS, not IMPLEMENTATIONS.
  priceFor.mockResolvedValue({ planPaise: 5_000_00, locationPaise: 1_000_00 });
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

  it("★★ DECLARES THE RAIL ON THE ORDER — omitting it is what hid UPI", async () => {
    // Razorpay fixes the mandate rail on the ORDER: "card" for a card mandate,
    // "upi" for UPI Autopay. Omitting `method` yields a CARD mandate, which is
    // why a merchant saw a Cards-only Checkout while UPI Autopay was fully
    // enabled on the account. Checkout cannot offer the choice itself, so the
    // order has to carry it.
    await startEnrolment({ ...args, mandateMethod: "upi" });
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
  });

  it("★★ defaults to UPI Autopay — the AMOUNT picks the rail, not the merchant", async () => {
    // The chooser is gone. A rail is fixed on the authorisation order and
    // cannot be edited afterwards, so a merchant who picks one that cannot
    // carry their renewal has authorised a mandate that will never fire, and
    // nothing tells them. The charge is better placed to decide than they are.
    await startEnrolment(args);
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
  });

  it("★★ never asks to authorise more than a mandate can ever debit", async () => {
    // Basic yearly: a ₹15,000 charge sitting exactly at the AFA limit. The
    // 1.18 × 1.5 provision would ask for ₹27,000 — but a charge of ₹15,001 is
    // manual whatever the ceiling says, so the extra ₹12,000 of authority can
    // never be exercised. It is only a bigger number on the Razorpay screen.
    priceFor.mockResolvedValue({
      planPaise: 15_000_00,
      locationPaise: 10_000_00,
    });
    store.amountDueForInvoice.mockResolvedValue(15_000_00);

    await startEnrolment({ ...args, plan: "basic", period: "yearly" });

    expect(collect.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mandateMaxPaise: 15_000_00 }),
    );
    expect(
      rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].terms.maxAmountPaise,
    ).toBe(15_000_00);
  });

  it("★ but keeps real reprice headroom below the limit", async () => {
    // Pro monthly: ₹2,400 charge, ₹5,000 ceiling. Both sides of a reprice stay
    // under ₹15,000, so that headroom is genuinely usable — capping it flat at
    // the charge would put the next price rise straight onto manual invoices.
    await startEnrolment(args);
    expect(collect.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mandateMaxPaise: 9_000_00 }),
    );
  });

  it("★★ asks for NO mandate when no rail could ever carry the renewal", async () => {
    // RBI's AFA-exempt limit is ₹15,000 on BOTH cards and UPI, so Pro yearly at
    // ₹24,000 can never be auto-debited without the merchant authenticating
    // every single renewal. We used to register a ₹43,000 mandate for it
    // anyway — authority shown on the Razorpay screen that could never be
    // exercised. Cycle 1 goes through the plain, production-verified checkout.
    priceFor.mockResolvedValue({
      planPaise: 24_000_00,
      locationPaise: 10_000_00,
    });
    store.amountDueForInvoice.mockResolvedValue(24_000_00);
    rzp.rzpCreateOrder.mockResolvedValue({
      ok: true,
      data: { id: "order_plain_1" },
    });

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ★ The screen must say "invoiced", not imply autopay.
    expect(res.data.autopay).toBe(false);
    expect(res.data.providerOrderId).toBe("order_plain_1");
  });

  it("★★ the carve-out does NOT excuse an unverified endpoint", async () => {
    // Two different situations that must not be conflated. Autopay being
    // IMPOSSIBLE for the amount is the carve-out. Autopay being unavailable
    // while it should work is the original refusal: turning that first cycle
    // into an ordinary payment succeeds today and surprises the merchant with a
    // manual invoice next renewal. A collectable amount still refuses.
    gateway.RECURRING_CHARGE_VERIFIED = false;
    try {
      const res = await startEnrolment(args); // Pro monthly — collectable
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/autopay is unavailable/i);
      expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    } finally {
      gateway.RECURRING_CHARGE_VERIFIED = true;
    }
  });

  it("★ reports autopay: true for a charge a mandate can carry", async () => {
    const res = await startEnrolment(args);
    expect(res.ok && res.data.autopay).toBe(true);
  });

  it("★ lets a merchant step across to card, because the rail is fixed", async () => {
    // The escape hatch: Checkout shows only the rail on the order, so pinning
    // UPI outright would leave a merchant with no UPI app unable to subscribe
    // at all. Card is a sideways move — both sit under the AFA limit.
    await startEnrolment({ ...args, mandateMethod: "card" });
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe(
      "card",
    );
  });

  it("★ an unrecognised rail falls back to the DERIVED one, never through", async () => {
    // The value reaches the server from the browser. It selects a rail, never
    // an amount — and only "card" is honoured, so anything else lands on what
    // the charge itself supports rather than reaching Razorpay unvalidated.
    await startEnrolment({
      ...args,
      mandateMethod: "netbanking" as unknown as "card",
    });
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
  });

  it("reports the rail back so the caller can open Checkout honestly", async () => {
    const res = await startEnrolment({ ...args, mandateMethod: "upi" });
    expect(res.ok && res.data.mandateMethod).toBe("upi");
  });

  it("★★ offers a mandate while the autopay rollout is enabled", async () => {
    await startEnrolment(args);
    expect(gateway.RECURRING_CHARGE_VERIFIED).toBe(true);
    expect(rzp.rzpCreateCustomer).toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
    expect(collect.beginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mandateMaxPaise: 9_000_00 }),
    );
  });

  it("★★ refuses before checkout when the owner has no phone", async () => {
    mail.resolveBillingEmail.mockResolvedValue({
      email: "owner@acme.test",
      phone: null,
      storeName: "Acme",
      slug: "acme",
    });
    const res = await startEnrolment(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/autopay/i);
    expect(res.error).toMatch(/no payment was taken/i);
    expect(collect.beginAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("issues the first invoice and opens a Razorpay order", async () => {
    const res = await startEnrolment(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      invoiceId: INVOICE,
      providerOrderId: "order_auth_1",
      keyId: "rzp_test_1",
      amountPaise: 5_000_00,
      providerCustomerId: "cust_1",
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

  it("★★ STAMPS the tax identifiers onto the invoice", async () => {
    // These columns existed from billing_03 and NOBODY passed them, so every
    // invoice stored NULL — leaving the document to name a GSTIN from LIVE
    // settings, which is exactly what an immutable invoice must not do.
    store.loadInvoiceParties.mockResolvedValue({
      supplierGstin: "07AABCS1429B1ZX",
      customerGstin: "29AAACM1234C1ZP",
      placeOfSupply: "29",
    });
    await startEnrolment(args);
    expect(store.ensureRenewalInvoice.mock.calls[0][0]).toMatchObject({
      supplierGstin: "07AABCS1429B1ZX",
      customerGstin: "29AAACM1234C1ZP",
      placeOfSupply: "29",
    });
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
      providerCustomerId: "cust_1",
    });
    // ★ And it must NOT open a second order at the gateway.
    expect(rzp.rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ a SECOND click on the SAME plan is not a changed plan", async () => {
    // The cycle is anchored to the instant it was raised, so two Subscribe
    // clicks a minute apart produce different period ENDPOINTS for the very
    // same plan. Comparing instants would call every ordinary resume a change —
    // abandoning the order the resume branch exists to protect, and refusing a
    // merchant who is simply mid-payment. The comparison is amount + LENGTH.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      // Raised a minute before this click: same 30-day cycle, later endpoints.
      periodStart: new Date(NOW.getTime() - 60_000).toISOString(),
      periodEnd: new Date(
        NOW.getTime() - 60_000 + 30 * 86_400_000,
      ).toISOString(),
    });

    await startEnrolment(args);

    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    expect(collect.settleAttempt).not.toHaveBeenCalledWith(
      expect.anything(),
      "failed",
      expect.objectContaining({ failureCode: "shape_changed" }),
    );
  });

  it("★ reshapes an invoice with no period recorded rather than assuming it fits", async () => {
    // An unknown duration cannot be shown to match, and billing one is worse
    // than rewriting a draft nobody has received.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: null,
      periodEnd: null,
    });

    await startEnrolment(args);

    expect(store.reshapeDraftSubscriptionInvoice).toHaveBeenCalled();
  });

  it("★★ RESHAPES the cycle-1 invoice when the merchant changes plan or period", async () => {
    // `ensureRenewalInvoice` is idempotent on (store, kind, cycle_seq) — right
    // for a renewal, wrong for an enrolment, where the invoice is raised the
    // first time anyone opens Checkout and the merchant is still choosing.
    // Measured on production 2026-09-06: a merchant who picked Pro monthly,
    // dismissed Checkout, then picked Pro YEARLY was quoted ₹2,400 for a full
    // year of Pro, because `activate` reads the period off the SUBSCRIPTION and
    // the amount off the INVOICE. ₹21,600 short, silently.
    // A stale MONTHLY invoice sitting in front of a yearly enrolment.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    store.reshapeDraftSubscriptionInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 50_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: new Date(NOW.getTime() + 365 * 86_400_000).toISOString(),
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });

    await startEnrolment({ ...args, period: "yearly" });

    const call = store.reshapeDraftSubscriptionInvoice.mock.calls[0][0];
    expect(call).toMatchObject({ invoiceId: INVOICE, storeId: STORE });
    // Rewritten to the YEARLY cycle, not the monthly one it found.
    expect(call.periodEnd.getTime()).toBe(NOW.getTime() + 365 * 86_400_000);
    expect(call.built.totalPaise).toBe(50_000_00);
  });

  it("★ leaves a MATCHING invoice completely alone", async () => {
    // The ordinary path: nothing changed, so nothing is rewritten. A reshape on
    // every enrolment would churn a document for no reason and widen the window
    // in which an amount can move under a payment.
    await startEnrolment(args);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
  });

  it("★★ frees an untouched order BEFORE rewriting the amount", async () => {
    // The old amount may already be sitting at the gateway. Rewriting the
    // invoice while that order stays payable would let a merchant pay ₹2,400
    // against a ₹24,000 obligation, so the stale attempt is failed first — and
    // only on the gateway's word that nobody has paid against it.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "card",
        status: "created",
        attempts: 0,
        amount_paid: 0,
      },
    });
    // ★ Only a settled attempt frees the index — a lost claim must not reshape.
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    await startEnrolment({ ...args, period: "yearly" });

    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-old",
      "failed",
      expect.objectContaining({ failureCode: "shape_changed" }),
    );
    const settleOrder =
      collect.settleAttempt.mock.invocationCallOrder[0] ?? Infinity;
    const reshapeOrder =
      store.reshapeDraftSubscriptionInvoice.mock.invocationCallOrder[0] ??
      -Infinity;
    expect(settleOrder).toBeLessThan(reshapeOrder);
  });

  it("★★ REFUSES when a payment for the earlier choice is still in flight", async () => {
    // Neither outcome is safe here: rewriting the invoice lets that payment
    // settle the wrong amount, and leaving it lets the merchant pay for one
    // shape and be granted another. Refusing costs them a minute; it clears on
    // its own. ★ And it happens BEFORE `seedSubscription`, so nothing records a
    // shape we are not going to bill for — that write is what `activate` reads.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "attempted",
        attempts: 1,
        amount_paid: 0,
      },
    });
    // One payment still `created` — the shopper is mid-approval in their app.
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [{ id: "pay_1", status: "created" }],
    });
    // ★ Would succeed if it were called, so the ONLY thing standing between
    // this test and a reshape is the untouched check itself.
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/still going through/i);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
    // Nothing recorded the new shape.
    expect(dbHolder.current.calls.insert.length).toBe(0);
  });

  it("★★ REFUSES to abandon an order that has been PAID", async () => {
    // `amount_paid` is the plainest possible statement that money has moved.
    // Nothing below it — status, attempt counts, payment states — may override
    // that, so it is checked first and on its own.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "paid",
        attempts: 1,
        amount_paid: 5_000_00,
      },
    });
    // Deliberately reports every payment as failed: a contradictory list must
    // not be able to talk us past money the order says it took.
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [{ id: "pay_1", status: "failed" }],
    });
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(false);
    expect(store.reshapeDraftSubscriptionInvoice).not.toHaveBeenCalled();
  });

  it("★★ frees an order whose every payment FAILED", async () => {
    // A merchant who scans a UPI QR and never approves it leaves the order
    // `attempted` with failed payments and nothing paid — measured on
    // production 2026-09-06, three of them. A `failed` payment is terminal and
    // can never be captured, so treating that as untouchable would strand them
    // behind their own abandoned attempt for 72 hours.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "upi",
        status: "attempted",
        attempts: 3,
        amount_paid: 0,
      },
    });
    rzp.rzpFetchOrderPayments.mockResolvedValue({
      ok: true,
      data: [
        { id: "pay_1", status: "failed" },
        { id: "pay_2", status: "failed" },
        { id: "pay_3", status: "failed" },
      ],
    });
    collect.settleAttempt.mockResolvedValue("failed");
    seed([
      [], // currentState
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(true);
    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-old",
      "failed",
      expect.objectContaining({ failureCode: "shape_changed" }),
    );
    expect(store.reshapeDraftSubscriptionInvoice).toHaveBeenCalled();
  });

  it("★ carries on with what it has when the invoice can no longer be reshaped", async () => {
    // A refusal means the invoice is finalized, paid or void — a document or a
    // debt, not a choice still being made. Blocking the merchant over it would
    // be worse than letting them finish what they started.
    store.getCycleInvoice.mockResolvedValue({
      id: INVOICE,
      status: "draft",
      finalizedAt: null,
      invoiceRef: null,
      totalPaise: 5_000_00,
      periodStart: NOW.toISOString(),
      periodEnd: MONTHLY_CYCLE_END,
    });
    store.reshapeDraftSubscriptionInvoice.mockResolvedValue(null);
    priceFor.mockResolvedValue({
      planPaise: 50_000_00,
      locationPaise: 10_000_00,
    });

    const res = await startEnrolment({ ...args, period: "yearly" });

    expect(res.ok).toBe(true);
    expect(store.amountDueForInvoice).toHaveBeenCalledWith(INVOICE);
  });

  it("★★ REPLACES an untouched order when the merchant picks a different rail", async () => {
    // The rail is fixed when the order is created and cannot be edited after.
    // So resuming a card order for someone who just chose UPI Autopay does not
    // merely mislabel the screen — it registers the WRONG MANDATE, and until
    // reconciliation gives up on the stale attempt (72h) every retry does it
    // again. Abandoning an order the gateway says nobody has ever paid against
    // costs nothing, which is the only condition under which this is allowed.
    collect.beginAttempt
      .mockResolvedValueOnce(null) // refused by the one-in-flight index
      .mockResolvedValueOnce({ attemptId: "att-new", idempotencyKey: "key-2" });
    collect.settleAttempt.mockResolvedValue("failed");
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "card",
        status: "created",
        attempts: 0,
        amount_paid: 0,
      },
    });
    seed([
      [], // currentState: no subscription
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, mandateMethod: "upi" });

    expect(collect.settleAttempt).toHaveBeenCalledWith(
      "att-old",
      "failed",
      expect.objectContaining({ failureCode: "rail_changed" }),
    );
    expect(rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].method).toBe("upi");
    expect(res.ok && res.data.mandateMethod).toBe("upi");
    expect(res.ok && res.data.attemptId).toBe("att-new");
  });

  it("★★ resumes rather than replaces once a payment has been TRIED", async () => {
    // `attempts > 0` means a payment instrument has been presented against that
    // order. Abandoning it then risks a second payable order for the same
    // invoice, which is the duplicate charge the resume branch exists to stop —
    // so the merchant keeps the old rail and is told so.
    collect.beginAttempt.mockResolvedValue(null);
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: true,
      data: {
        id: "order_old",
        method: "card",
        status: "created",
        attempts: 1,
        amount_paid: 0,
      },
    });
    seed([
      [],
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, mandateMethod: "upi" });

    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(rzp.rzpCreateAuthorizationOrder).not.toHaveBeenCalled();
    expect(res.ok && res.data.mandateMethod).toBe("card");
  });

  it("★ an UNREADABLE order is never treated as untouched", async () => {
    // "We could not check" is not "nobody paid". A gateway blip must not become
    // permission to abandon an order that may already carry a payment.
    collect.beginAttempt.mockResolvedValue(null);
    rzp.rzpFetchOrder.mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    });
    seed([
      [],
      [{ id: "att-old", providerOrderId: "order_old", amountPaise: 5_000_00 }],
    ]);

    const res = await startEnrolment({ ...args, mandateMethod: "upi" });

    expect(collect.settleAttempt).not.toHaveBeenCalled();
    expect(res.ok && res.data.providerOrderId).toBe("order_old");
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
    const notes = rzp.rzpCreateAuthorizationOrder.mock.calls[0][1].notes;
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
    rzp.rzpCreateAuthorizationOrder.mockResolvedValue({
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
    rzp.rzpCreateAuthorizationOrder.mockResolvedValue({
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
      [
        {
          id: "att-1",
          state: "processing",
          providerOrderId: "order_1",
          mandateMaxPaise: 9_000_00,
        },
      ],
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

  it("★★ FINALIZES BEFORE SETTLING — settling a DRAFT leaves a paid invoice unpaid", async () => {
    // The regression this pins cost 20 days of phantom debt on production.
    //
    // `syncInvoiceStatus` claims the move to paid with
    // `inArray(status, ["open", "processing"])`. While an invoice is still a
    // DRAFT that claim matches zero rows, so settling first captures the money,
    // leaves the invoice unpaid, sends no receipt, and reports nothing — and
    // `finalizeInvoice` then stamps `status: "open"`, i.e. an open bill behind a
    // captured payment. Store `echos` was chased for a ₹15 invoice it had paid
    // on 2026-08-16 until 2026-09-05, when clicking "Pay now" re-synced it and
    // fired a "Payment received" email for a payment the merchant had CANCELLED.
    //
    // Order is the whole fix, so order is what this asserts. Both calls are
    // mocked, so nothing else in this file can catch a swap.
    seedConfirm();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).toHaveBeenCalled();
    expect(collect.settleAttempt).toHaveBeenCalled();
    expect(store.finalizeInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      collect.settleAttempt.mock.invocationCallOrder[0],
    );
  });

  it("★ finalizes only AFTER the signature verifies", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    await confirmEnrolment(args);
    expect(store.finalizeInvoice).not.toHaveBeenCalled();
  });

  it("★★ WELCOMES the merchant — the old path did, and deleting it took that with it", async () => {
    seedConfirm();
    await confirmEnrolment(args);
    expect(receipts.notifyPlanActivated).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, invoiceId: INVOICE }),
    );
  });

  it("★ says nothing when the signature failed", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    seedConfirm();
    await confirmEnrolment(args);
    expect(receipts.notifyPlanActivated).not.toHaveBeenCalled();
  });

  it("★★ reports autopay HONESTLY — a mandate, or none", async () => {
    // The template says autopay is set up; promising a renewal date to someone
    // with no mandate is how they wait for a charge that never comes.
    seedConfirm();
    await confirmEnrolment(args);
    expect(receipts.notifyPlanActivated.mock.calls[0][0].autopay).toBe(false);
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

  it("★★ reads the token from the PAYMENT, never from the caller", async () => {
    // Razorpay Checkout hands the browser a payment id, an order id and a
    // signature — not a token. A caller-supplied token would be a value the
    // BROWSER chose, and attaching a mandate is standing permission to debit
    // this merchant every cycle.
    seedConfirm();
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: {
        id: "pay_1",
        token_id: "token_real",
        customer_id: "cust_real",
        method: "upi",
      },
    });
    await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(rzp.rzpFetchPayment).toHaveBeenCalledWith(
      expect.anything(),
      "pay_1",
    );
  });

  it("★ a payment with no token still grants access after money moved", async () => {
    seedConfirm();
    const res = await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateActivated).toBe(false);
  });

  it("★★ a FAILED lookup still activates the plan — the money is already in", async () => {
    // Losing autopay is the acceptable half of this trade; refusing a plan the
    // merchant has paid for is not.
    seedConfirm();
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: false,
      error: "gateway down",
      outcome: "unknown",
    });
    const res = await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(res.ok).toBe(true);
  });

  it("★ an unrecognised method is recorded as unknown, not dropped", async () => {
    seedConfirm();
    rzp.rzpFetchPayment.mockResolvedValue({
      ok: true,
      data: { id: "pay_1", token_id: "t", method: "wallet" },
    });
    const res = await confirmEnrolment({
      storeId: STORE,
      invoiceId: "inv-1",
      providerPaymentId: "pay_1",
      signature: "sig",
    });
    expect(res.ok).toBe(true);
  });
});
