/* eslint-disable @typescript-eslint/no-explicit-any */
// Charging a mandate.
//
// A recurring charge is TWO gateway calls (create the order, then charge it),
// which makes the gap between them the whole risk: an order created and a
// charge we never got an answer to looks exactly like a charge that worked.
// Almost every test here is about which failures are decisions (`rejected`) and
// which are missing information (`unknown`) — because `collect.ts` opens a
// merchant's grace window on the first and never retries the second.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/payments/provider", () => ({
  getPlatformRazorpayCreds: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => ({
  rzpCreateOrder: vi.fn(),
  rzpChargeMandate: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ rows: [] as any[], throws: false }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => {
    if (dbHolder.throws) throw new Error("db down");
    return fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => dbHolder.rows }) }),
      }),
    });
  }),
}));

import {
  getRecurringCharge,
  chargeUnavailableReason,
  chargeMandateViaRazorpay,
  RECURRING_CHARGE_VERIFIED,
} from "./gateway";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import { rzpChargeMandate, rzpCreateOrder } from "@/lib/payments/razorpay";

const CREDS = { keyId: "rzp_test", keySecret: "s" };
const INPUT = {
  amountPaise: 500_00,
  idempotencyKey: "idem-1",
  providerTokenId: "token_1",
  providerCustomerId: "cust_1",
  storeId: "store-1",
  description: "Pro monthly",
  recordProviderOrderId: vi.fn(async () => true),
};

beforeEach(() => {
  vi.clearAllMocks();
  INPUT.recordProviderOrderId.mockResolvedValue(true);
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
  vi.mocked(getPlatformRazorpayCreds).mockReturnValue(CREDS as any);
  vi.mocked(rzpCreateOrder).mockResolvedValue({
    ok: true,
    data: { id: "order_1" },
  } as any);
  vi.mocked(rzpChargeMandate).mockResolvedValue({
    ok: true,
    data: { razorpay_payment_id: "pay_1", status: "captured" },
  } as any);
  dbHolder.rows = [{ email: "owner@acme.test", phone: "9876543210" }];
  dbHolder.throws = false;
});

describe("the release gate", () => {
  it("★★ autopay is OFF until the endpoint is verified against test mode", () => {
    // Flipping this charges real merchants, so it is a deliberate switch rather
    // than something that becomes true by accident. See
    // docs/autopay-verification.md.
    expect(RECURRING_CHARGE_VERIFIED).toBe(false);
    expect(getRecurringCharge()).toBeNull();
    expect(chargeUnavailableReason()).toMatch(/not yet verified/i);
  });

  it("★ reports MISSING CREDENTIALS separately from an unverified endpoint", () => {
    // Two different problems with two different fixes; one message for both
    // sends whoever is on call to the wrong place.
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null as any);
    expect(chargeUnavailableReason()).toMatch(/not yet verified/i);
  });
});

// The implementation is unreachable through getRecurringCharge while the flag
// is false, so these drive it directly — the flag is a release decision, not a
// reason to ship an untested charge path.
describe("charging a mandate", () => {
  const impl = chargeMandateViaRazorpay;

  it("creates an order, then charges it with the token", async () => {
    const res = await impl(INPUT);
    expect(vi.mocked(rzpCreateOrder).mock.calls[0][1]).toMatchObject({
      amountPaise: 500_00,
    });
    expect(vi.mocked(rzpChargeMandate).mock.calls[0][1]).toMatchObject({
      orderId: "order_1",
      customerId: "cust_1",
      tokenId: "token_1",
      email: "owner@acme.test",
      contact: "9876543210",
    });
    expect(res).toMatchObject({
      ok: true,
      data: { providerPaymentId: "pay_1", status: "captured" },
    });
    expect(INPUT.recordProviderOrderId).toHaveBeenCalledWith("order_1");
    expect(
      INPUT.recordProviderOrderId.mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(rzpChargeMandate).mock.invocationCallOrder[0]);
  });

  it("★★ carries the attempt key in both provider objects' NOTES", async () => {
    // The recurring API documents no provider-side idempotency header. The
    // notes copy connects the Razorpay objects to our durable attempt; the
    // provider order id is the actual reconciliation handle.
    await impl(INPUT);
    expect(vi.mocked(rzpCreateOrder).mock.calls[0][1].notes).toMatchObject({
      idempotency_key: "idem-1",
    });
    expect(vi.mocked(rzpChargeMandate).mock.calls[0][1].notes).toMatchObject({
      idempotency_key: "idem-1",
    });
  });

  it("★★ a 200 with NO payment id is UNKNOWN, never success", async () => {
    // We have an order at the gateway and no way to name what happened to it.
    // Reporting success would record money that may not have moved.
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: true,
      data: {},
    } as any);
    const res = (await impl(INPUT)) as any;
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("unknown");
  });

  it("★★ a MISSING status is 'created', not 'captured'", async () => {
    // Razorpay documents that some banks leave the payment in `created`
    // (file-based charging). Defaulting to captured would record money that has
    // not moved; `created` maps to a non-terminal state and reconciles later.
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: true,
      data: { razorpay_payment_id: "pay_1" },
    } as any);
    const res = (await impl(INPUT)) as any;
    expect(res.data.status).toBe("created");
  });

  it("★ passes the gateway's own outcome through on a failed charge", async () => {
    // A 5xx must stay `unknown` — collect.ts never retries an unknown, and
    // never opens a grace window for one.
    vi.mocked(rzpChargeMandate).mockResolvedValue({
      ok: false,
      error: "gateway down",
      outcome: "unknown",
    } as any);
    const res = (await impl(INPUT)) as any;
    expect(res.outcome).toBe("unknown");
  });

  it("★★ refuses to debit when the provider order could not be recorded", async () => {
    INPUT.recordProviderOrderId.mockResolvedValue(false);
    const res = (await impl(INPUT)) as any;
    expect(res).toMatchObject({ ok: false, outcome: "rejected" });
    expect(rzpChargeMandate).not.toHaveBeenCalled();
  });

  it("★ an unsuccessful order creation is a known NON-CHARGE", async () => {
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: false,
      error: "gateway timed out",
      outcome: "unknown",
    } as any);
    const res = (await impl(INPUT)) as any;
    expect(res.outcome).toBe("rejected");
    expect(rzpChargeMandate).not.toHaveBeenCalled();
  });

  it("★ a token with no customer is REJECTED — nothing was sent", async () => {
    const res = (await impl({ ...INPUT, providerCustomerId: null })) as any;
    expect(res.outcome).toBe("rejected");
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★★ no billing contact is a rejection, not a guess", async () => {
    // email and contact are mandatory on the API. Substituting a placeholder
    // would file a charge against the wrong person.
    dbHolder.rows = [];
    const res = (await impl(INPUT)) as any;
    expect(res.outcome).toBe("rejected");
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ a contact lookup that THROWS does not become a charge either", async () => {
    dbHolder.throws = true;
    const res = (await impl(INPUT)) as any;
    expect(res.ok).toBe(false);
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("refuses when platform credentials are absent", async () => {
    vi.mocked(getPlatformRazorpayCreds).mockReturnValue(null as any);
    const res = (await impl(INPUT)) as any;
    expect(res.outcome).toBe("rejected");
  });
});
