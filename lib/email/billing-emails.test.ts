/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: (fn: any) => fn(dbHolder.current.db),
}));

import {
  resolveBillingEmail,
  planActivatedTemplate,
  paymentReceiptTemplate,
  paymentFailedTemplate,
  subscriptionCancelledTemplate,
  planDowngradedTemplate,
  renewalDueTemplate,
} from "./billing-emails";

const MANAGE = "https://echos.storemink.com/dashboard/plans";

describe("billing email templates", () => {
  it("plan activated — includes plan, price, renewal", () => {
    const e = planActivatedTemplate({
      storeName: "Echos",
      planName: "Basic",
      amountInr: 500,
      period: "monthly",
      renewsOn: "2026-08-12T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(e.subject).toContain("Basic");
    expect(e.html).toContain("₹500");
    expect(e.html).toContain("month");
    expect(e.html).toContain("12 Aug 2026");
    expect(e.html).toContain(MANAGE);
  });

  it("payment receipt — shows the charged amount", () => {
    const e = paymentReceiptTemplate({
      storeName: "Echos",
      planName: "Pro",
      amountInr: 1500,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.subject).toMatch(/payment received/i);
    expect(e.html).toContain("₹1,500");
  });

  it("payment failed — retry vs final wording differ", () => {
    const retry = paymentFailedTemplate({
      storeName: "Echos",
      planName: "Basic",
      final: false,
      accessUntil: null,
      manageUrl: MANAGE,
    });
    const final = paymentFailedTemplate({
      storeName: "Echos",
      planName: "Basic",
      final: true,
      accessUntil: "2026-08-15T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(retry.html).toMatch(/retry/i);
    expect(final.subject).toMatch(/action needed/i);
    expect(final.html).toContain("15 Aug 2026");
  });

  it("cancellation — mentions access-until + re-subscribe", () => {
    const e = subscriptionCancelledTemplate({
      storeName: "Echos",
      planName: "Pro",
      accessUntil: "2026-09-01T00:00:00.000Z",
      manageUrl: MANAGE,
    });
    expect(e.subject).toMatch(/cancelled/i);
    // en-GB short month for September is "Sept" in modern ICU.
    expect(e.html).toMatch(/0?1 Sept? 2026/);
    expect(e.html).toMatch(/re-subscribe/i);
  });

  it("downgrade — reassures data is safe", () => {
    const e = planDowngradedTemplate({
      storeName: "Echos",
      fromPlanName: "Basic",
      manageUrl: MANAGE,
    });
    expect(e.subject).toMatch(/free plan/i);
    expect(e.html).toMatch(/nothing was deleted/i);
  });

  it("escapes HTML in the store name", () => {
    const e = planActivatedTemplate({
      storeName: "<script>x</script>",
      planName: "Basic",
      amountInr: 500,
      period: "monthly",
      renewsOn: null,
      manageUrl: MANAGE,
    });
    expect(e.html).not.toContain("<script>x</script>");
    expect(e.html).toContain("&lt;script&gt;");
  });
});

/**
 * ★★ THE REGRESSION THIS PINS: no phone, no subscription.
 *
 * `startEnrolment` refuses before Razorpay unless it gets BOTH fields back, so
 * a null phone here is not a cosmetic omission — it is a store that cannot
 * subscribe at all. `admins.phone` was the only source and signup never wrote
 * it, which took every wizard-created store's Subscribe button out of service.
 */
describe("renewalDueTemplate — naming a reprice", () => {
  const base = {
    storeName: "Echos",
    planName: "Pro",
    amountInr: 3000,
    dueOn: "2026-10-06T00:00:00.000Z",
    invoiceRef: "SM/2026-27/0007",
    autopay: true,
    manageUrl: MANAGE,
  };

  it("★★ says a rise is a rise, in both the autopay and the bill wording", () => {
    // The amount alone does not tell a merchant it CHANGED — they would have to
    // remember last cycle's figure. An unexplained larger debit is what turns
    // an operator reprice into a chargeback.
    for (const autopay of [true, false]) {
      const e = renewalDueTemplate({
        ...base,
        autopay,
        previousAmountInr: 2400,
      });
      expect(e.html).toContain("an increase");
      expect(e.html).toContain("₹2,400");
    }
  });

  it("★ calls a reduction a reduction", () => {
    // "Your price has changed" reads as a rise to everyone, so a merchant whose
    // bill went DOWN would write in to ask what went wrong.
    const e = renewalDueTemplate({ ...base, previousAmountInr: 4000 });
    expect(e.html).toContain("a reduction");
    expect(e.html).not.toContain("an increase");
  });

  it("★ stays silent when the price did not move", () => {
    // Noise on an unchanged bill is what teaches people to stop reading
    // billing email — the one channel that must still be read.
    for (const previousAmountInr of [3000, null, undefined]) {
      const e = renewalDueTemplate({ ...base, previousAmountInr });
      expect(e.html).not.toContain("an increase");
      expect(e.html).not.toContain("a reduction");
      expect(e.html).not.toContain("last time");
    }
  });
});

describe("resolveBillingEmail", () => {
  const STORE = "store-1";
  const store = [{ name: "Echos", slug: "echos" }];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function seed(owner: any[], billing: any[]) {
    dbHolder.current = makeDbMock({ selectQueue: [store, owner, billing] });
  }

  it("prefers the owner's own verified number", async () => {
    seed(
      [{ email: "owner@echos.test", phone: "+919000000001" }],
      [{ contact_email: "billing@echos.test", contact_phone: "+919000000002" }],
    );
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "owner@echos.test",
      phone: "+919000000001",
    });
  });

  it("★★ falls back to the invoice contact phone when the admin row has none", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "+919814468834" }],
    );
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "owner@echos.test",
      phone: "+919814468834",
    });
  });

  it("normalises the invoice contact phone to E.164", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "98144 68834" }],
    );
    expect((await resolveBillingEmail(STORE))?.phone).toBe("+919814468834");
  });

  it("★ refuses a landline or placeholder rather than registering an unreachable mandate", async () => {
    seed(
      [{ email: "owner@echos.test", phone: null }],
      [{ contact_email: null, contact_phone: "022-24001234" }],
    );
    expect((await resolveBillingEmail(STORE))?.phone).toBeNull();
  });

  it("never pairs the owner's number with someone else's billing email", async () => {
    seed([], [{ contact_email: "billing@echos.test", contact_phone: null }]);
    expect(await resolveBillingEmail(STORE)).toMatchObject({
      email: "billing@echos.test",
      phone: null,
    });
  });

  it("is null when no email exists at all", async () => {
    seed([], [{ contact_email: null, contact_phone: "+919814468834" }]);
    expect(await resolveBillingEmail(STORE)).toBeNull();
  });
});
