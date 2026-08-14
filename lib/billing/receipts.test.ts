/* eslint-disable @typescript-eslint/no-explicit-any */
// Telling the merchant something good happened.
//
// All three of these were sent by the old Razorpay-Subscriptions path and lost
// when it was deleted, so for a few days a merchant could subscribe, pay
// ₹50,000 and hear nothing. The tests worth having are about not repeating that
// and not over-promising: an activation must not claim autopay a merchant does
// not have, and a credit purchase must not get a subscription receipt.

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

const mail = vi.hoisted(() => ({
  resolveBillingEmail: vi.fn(),
  sendBillingEmail: vi.fn(),
  manageUrl: vi.fn<(slug: string) => string>(() => "https://acme/plans"),
  paymentReceiptTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "receipt",
    html: "<p>r</p>",
  })),
  planActivatedTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "welcome",
    html: "<p>w</p>",
  })),
  subscriptionCancelledTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "cancelled",
    html: "<p>c</p>",
  })),
}));
vi.mock("@/lib/email/billing-emails", () => mail);

import {
  notifyInvoicePaid,
  notifyPlanActivated,
  notifySubscriptionCancelled,
} from "./receipts";

const STORE = "store-1";

const SUB = {
  plan: "pro",
  period: "yearly",
  currentPeriodEnd: "2027-09-01T00:00:00.000Z",
};

/** invoice, then subscription. */
function seed(invoice: any = null, sub: any = SUB) {
  dbHolder.current = makeDbMock({
    selectQueue: [invoice ? [invoice] : [], sub ? [sub] : []],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not implementations — restore the happy path.
  mail.sendBillingEmail.mockResolvedValue(undefined);
  mail.resolveBillingEmail.mockResolvedValue({
    email: "owner@acme.test",
    storeName: "Acme",
    slug: "acme",
  });
});

describe("notifyInvoicePaid", () => {
  const invoice = {
    kind: "subscription",
    totalPaise: 5_900_000,
    periodEnd: "2027-09-01T00:00:00.000Z",
  };

  it("sends a receipt for the amount on the document", async () => {
    seed(invoice);
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.paymentReceiptTemplate.mock.calls[0][0]).toMatchObject({
      amountInr: 59_000,
      planName: "Pro",
      period: "yearly",
    });
    expect(mail.sendBillingEmail).toHaveBeenCalled();
  });

  it("★★ says NOTHING for an AI credit purchase", async () => {
    // A receipt reading "your Pro plan is active" for a ₹59 credit pack is
    // wrong; credits have their own confirmation.
    seed({ ...invoice, kind: "ai_credits" });
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★ says nothing when there is no billing contact", async () => {
    mail.resolveBillingEmail.mockResolvedValue(null);
    seed(invoice);
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★ says nothing when the invoice cannot be read", async () => {
    seed(null);
    await notifyInvoicePaid(STORE, "inv-1");
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws — the money is already recorded", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    seed(invoice);
    await expect(notifyInvoicePaid(STORE, "inv-1")).resolves.toBeUndefined();
  });
});

describe("notifyPlanActivated", () => {
  const invoice = {
    kind: "subscription",
    totalPaise: 5_000_00,
    periodEnd: null,
  };

  it("welcomes them onto the plan they paid for", async () => {
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0]).toMatchObject({
      planName: "Pro",
      amountInr: 5_000,
      period: "yearly",
    });
  });

  it("★★ WITHHOLDS the renewal date when there is no autopay", async () => {
    // The template's copy says autopay is set up. Naming a date beside that,
    // for a merchant with no mandate, promises a charge that never comes — and
    // they are downgraded for waiting.
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: false,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0].renewsOn).toBeNull();
  });

  it("names the date when autopay really is on", async () => {
    seed(invoice);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.planActivatedTemplate.mock.calls[0][0].renewsOn).toBe(
      SUB.currentPeriodEnd,
    );
  });

  it("★ says nothing when there is no subscription to describe", async () => {
    seed(invoice, null);
    await notifyPlanActivated({
      storeId: STORE,
      invoiceId: "inv-1",
      autopay: true,
    });
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws — the plan is already active", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    seed(invoice);
    await expect(
      notifyPlanActivated({
        storeId: STORE,
        invoiceId: "inv-1",
        autopay: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("notifySubscriptionCancelled", () => {
  it("★ confirms it, naming what they keep and until when", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: "2026-10-01T00:00:00.000Z",
    });
    expect(mail.subscriptionCancelledTemplate.mock.calls[0][0]).toMatchObject({
      planName: "Pro",
      accessUntil: "2026-10-01T00:00:00.000Z",
    });
  });

  it("★ survives having no cycle to name", async () => {
    // Cancelling between authorising and the first charge: nothing was paid
    // for, so there is no date to promise.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    await notifySubscriptionCancelled({
      storeId: STORE,
      plan: "pro",
      accessUntil: null,
    });
    expect(
      mail.subscriptionCancelledTemplate.mock.calls[0][0].accessUntil,
    ).toBeNull();
  });

  it("★★ NEVER throws — the cancellation is already committed", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    dbHolder.current = makeDbMock({ selectQueue: [] });
    await expect(
      notifySubscriptionCancelled({
        storeId: STORE,
        plan: "pro",
        accessUntil: null,
      }),
    ).resolves.toBeUndefined();
  });
});
