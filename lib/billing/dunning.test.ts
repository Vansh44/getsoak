/* eslint-disable @typescript-eslint/no-explicit-any */
// Telling the merchant.
//
// The invariant that matters most here is the DULLEST one: none of these may
// throw. They are called from the renewal worker between a finalize and a
// charge, and after a downgrade claim has already committed — so a mail provider
// having a bad afternoon must never fail a collection, block a cycle, or abort a
// downgrade. Everything else is about not lying to the merchant.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const mail = vi.hoisted(() => ({
  resolveBillingEmail: vi.fn(),
  sendBillingEmail: vi.fn(),
  manageUrl: vi.fn<(slug: string) => string>(
    () => "https://acme.storemink.com/dashboard/plans",
  ),
  // Typed args so `mock.calls[0][0]` is reachable — these tests assert on what
  // the templates were ASKED for, which is where the honesty lives.
  renewalDueTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "due",
    html: "<p>d</p>",
  })),
  renewalOverdueTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "late",
    html: "<p>l</p>",
  })),
  planDowngradedTemplate: vi.fn<(d: any) => unknown>(() => ({
    subject: "free",
    html: "<p>f</p>",
  })),
}));
vi.mock("@/lib/email/billing-emails", () => mail);

const notif = vi.hoisted(() => ({ recordEvent: vi.fn() }));
vi.mock("@/lib/notifications/record", () => notif);

import {
  notifyDowngraded,
  notifyGraceStarted,
  notifyInvoiceIssued,
} from "./dunning";

const STORE = "store-1";
const DUE = new Date("2026-09-05T00:00:00.000Z");

beforeEach(() => {
  // ⚠ clearAllMocks clears CALLS, not implementations — so a mockRejectedValue
  // set by one test leaks into every test after it. The happy path is restored
  // explicitly here rather than with resetAllMocks(), which would also wipe the
  // template stubs' return values.
  vi.clearAllMocks();
  mail.sendBillingEmail.mockResolvedValue(undefined);
  notif.recordEvent.mockResolvedValue(null);
  mail.resolveBillingEmail.mockResolvedValue({
    email: "owner@acme.test",
    storeName: "Acme",
    slug: "acme",
  });
});

describe("notifyInvoiceIssued", () => {
  const args = {
    storeId: STORE,
    plan: "pro",
    amountPaise: 7_000_00,
    dueAt: DUE,
    invoiceRef: "SM/2026-27/00004",
    autopay: false,
  };

  it("mails the billing contact and logs the event", async () => {
    await notifyInvoiceIssued(args);
    expect(mail.sendBillingEmail).toHaveBeenCalledWith(
      "owner@acme.test",
      expect.objectContaining({ subject: "due" }),
      STORE,
    );
    expect(notif.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscription.invoice_due" }),
    );
  });

  it("★ quotes the amount in RUPEES, resolved from the plan id", async () => {
    await notifyInvoiceIssued(args);
    expect(mail.renewalDueTemplate.mock.calls[0][0]).toMatchObject({
      amountInr: 7_000,
      planName: "Pro",
      autopay: false,
    });
  });

  it("★★ passes autopay through unchanged — it decides what the email IS", async () => {
    await notifyInvoiceIssued({ ...args, autopay: true });
    expect(mail.renewalDueTemplate.mock.calls[0][0].autopay).toBe(true);
  });

  it("★ does nothing when the store has no billing contact", async () => {
    mail.resolveBillingEmail.mockResolvedValue(null);
    await notifyInvoiceIssued(args);
    expect(mail.sendBillingEmail).not.toHaveBeenCalled();
  });

  it("★★ NEVER throws — a mail outage must not fail a collection", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyInvoiceIssued(args)).resolves.toBeUndefined();
  });

  it("★ never throws when the recipient lookup itself fails", async () => {
    mail.resolveBillingEmail.mockRejectedValue(new Error("db down"));
    await expect(notifyInvoiceIssued(args)).resolves.toBeUndefined();
  });
});

describe("notifyGraceStarted", () => {
  const args = {
    storeId: STORE,
    plan: "basic",
    graceEndsAt: DUE,
    autopayAttempted: false,
  };

  it("★★ does not claim an attempt that never happened", async () => {
    await notifyGraceStarted(args);
    expect(mail.renewalOverdueTemplate.mock.calls[0][0]).toMatchObject({
      attempted: false,
      planName: "Basic",
    });
  });

  it("reports a real attempt when autopay ran", async () => {
    await notifyGraceStarted({ ...args, autopayAttempted: true });
    expect(mail.renewalOverdueTemplate.mock.calls[0][0].attempted).toBe(true);
  });

  it("logs it in-app as a payment failure", async () => {
    await notifyGraceStarted(args);
    expect(notif.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "subscription.payment_failed" }),
    );
  });

  it("★★ NEVER throws — grace has already started in the database", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyGraceStarted(args)).resolves.toBeUndefined();
  });
});

describe("notifyDowngraded", () => {
  const args = { storeId: STORE, fromPlan: "pro" };

  it("names the plan that was lost", async () => {
    await notifyDowngraded(args);
    expect(mail.planDowngradedTemplate.mock.calls[0][0]).toMatchObject({
      fromPlanName: "Pro",
      storeName: "Acme",
    });
  });

  it("★★ NEVER throws — the downgrade is already committed", async () => {
    mail.sendBillingEmail.mockRejectedValue(new Error("resend down"));
    await expect(notifyDowngraded(args)).resolves.toBeUndefined();
  });

  it("★ never throws when the event write fails", async () => {
    notif.recordEvent.mockRejectedValue(new Error("db down"));
    await expect(notifyDowngraded(args)).resolves.toBeUndefined();
  });
});
