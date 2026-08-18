/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("./provider", () => ({ getLiveStoreGateway: vi.fn() }));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("./razorpay", () => ({
  rzpCreateOrder: vi.fn(),
  rzpFetchPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));

import { getLiveStoreGateway } from "./provider";
import {
  rzpCreateOrder,
  rzpFetchPayment,
  verifyCheckoutSignature,
} from "./razorpay";
import { makeDbMock } from "@/app/actions/_test-helpers";
import {
  MAX_COUNTER_PAYMENT_PAISE,
  startCounterPayment,
  verifyCounterPayment,
  verifyGatewayTenders,
} from "./pos-gateway";

const CREDS = { keyId: "rzp_test_x", keySecret: "shhh" };

/** A captured ₹100 payment, as Razorpay reports one. */
const captured = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: {
    id: "pay_1",
    order_id: "order_1",
    amount: 10_000,
    currency: "INR",
    status: "captured",
    ...over,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks wipes CALLS, not implementations — restore the defaults
  // explicitly or they leak into whatever runs next (CODEBASE §5.8).
  vi.mocked(getLiveStoreGateway).mockResolvedValue(CREDS);
  vi.mocked(verifyCheckoutSignature).mockReturnValue(true);
  vi.mocked(rzpFetchPayment).mockResolvedValue(captured() as never);
  vi.mocked(rzpCreateOrder).mockResolvedValue({
    ok: true,
    data: { id: "order_1" },
  } as never);
  // No prior payment carries this reference — the replay lookup finds nothing.
  dbHolder.current = makeDbMock({ selectQueue: [[]] });
});

describe("startCounterPayment", () => {
  it("opens an order for the amount the cashier named", async () => {
    const res = await startCounterPayment("store-1", { amountPaise: 20_000 });
    expect(res).toEqual({
      ok: true,
      data: { rzpOrderId: "order_1", keyId: "rzp_test_x", amountPaise: 20_000 },
    });
  });

  it("★ refuses when the store has no live gateway", async () => {
    // Not connected, paused, or a lapsed plan — getLiveStoreGateway folds all
    // three into null, and none of them may open an order.
    vi.mocked(getLiveStoreGateway).mockResolvedValue(null);
    const res = await startCounterPayment("store-1", { amountPaise: 20_000 });
    expect(res).toMatchObject({ ok: false });
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("refuses a sub-₹1 or non-integer amount", async () => {
    for (const amountPaise of [0, 99, -500, 12.5]) {
      expect(await startCounterPayment("s", { amountPaise })).toMatchObject({
        ok: false,
      });
    }
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("★ refuses an absurd amount before it reaches the gateway", async () => {
    // A mistyped amount must not open a huge order on the merchant's account.
    const res = await startCounterPayment("s", {
      amountPaise: MAX_COUNTER_PAYMENT_PAISE + 1,
    });
    expect(res).toMatchObject({ ok: false });
    expect(rzpCreateOrder).not.toHaveBeenCalled();
  });

  it("distinguishes a refusal from an unreachable gateway", async () => {
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: false,
      error: "boom",
      outcome: "unknown",
    } as never);
    const res = await startCounterPayment("s", { amountPaise: 10_000 });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/couldn't reach/i);
  });
});

describe("verifyCounterPayment", () => {
  it("accepts a captured payment for the exact amount", async () => {
    const res = await verifyCounterPayment("store-1", {
      paymentId: "pay_1",
      expectedPaise: 10_000,
    });
    expect(res).toEqual({
      ok: true,
      data: { paymentId: "pay_1", amountPaise: 10_000 },
    });
  });

  it("★★ refuses when the captured amount is less than the tender", async () => {
    // THE check the whole step exists for. Without it a client could claim
    // ₹500 against a real ₹100 payment and settle the sale for the difference.
    const res = await verifyCounterPayment("store-1", {
      paymentId: "pay_1",
      expectedPaise: 50_000,
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/doesn't match/i);
  });

  it("★★ refuses a payment that is not captured", async () => {
    for (const status of ["authorized", "created", "failed", "refunded"]) {
      vi.mocked(rzpFetchPayment).mockResolvedValue(
        captured({ status }) as never,
      );
      const res = await verifyCounterPayment("s", {
        paymentId: "pay_1",
        expectedPaise: 10_000,
      });
      expect(res).toMatchObject({ ok: false });
    }
  });

  it("★★ refuses when the gateway can't be read at all", async () => {
    // Unlike verifyCapturedCheckoutPayment, which falls back to the HMAC: a
    // till sale is born PAID with no pending state to reconcile from, so an
    // unverified completion is money the shop may never have received. The
    // customer's money is safe either way, so "try again" is the honest answer.
    vi.mocked(rzpFetchPayment).mockResolvedValue({
      ok: false,
      error: "timeout",
      outcome: "unknown",
    } as never);
    const res = await verifyCounterPayment("s", {
      paymentId: "pay_1",
      expectedPaise: 10_000,
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/don't take it again/i);
  });

  it("refuses a non-INR payment", async () => {
    vi.mocked(rzpFetchPayment).mockResolvedValue(
      captured({ currency: "USD" }) as never,
    );
    expect(
      await verifyCounterPayment("s", {
        paymentId: "pay_1",
        expectedPaise: 10_000,
      }),
    ).toMatchObject({ ok: false });
  });

  it("★ refuses a bad checkout signature without asking the gateway", async () => {
    vi.mocked(verifyCheckoutSignature).mockReturnValue(false);
    const res = await verifyCounterPayment("s", {
      paymentId: "pay_1",
      rzpOrderId: "order_1",
      signature: "forged",
      expectedPaise: 10_000,
    });
    expect(res).toMatchObject({ ok: false });
    expect(rzpFetchPayment).not.toHaveBeenCalled();
  });

  it("★ a signature without its order id is not verifiable", async () => {
    const res = await verifyCounterPayment("s", {
      paymentId: "pay_1",
      signature: "sig",
      expectedPaise: 10_000,
    });
    expect(res).toMatchObject({ ok: false });
    expect(rzpFetchPayment).not.toHaveBeenCalled();
  });

  it("★ re-verification at sale time needs no signature", async () => {
    // placePosSale re-checks with the payment id alone — the tender carries no
    // signature, and the gateway read is what actually settles the question.
    const res = await verifyCounterPayment("s", {
      paymentId: "pay_1",
      expectedPaise: 10_000,
    });
    expect(res).toMatchObject({ ok: true });
    expect(verifyCheckoutSignature).not.toHaveBeenCalled();
  });

  it("refuses an empty reference", async () => {
    expect(
      await verifyCounterPayment("s", {
        paymentId: "   ",
        expectedPaise: 10_000,
      }),
    ).toMatchObject({ ok: false });
    expect(rzpFetchPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// verifyGatewayTenders — the check BOTH counters run.
//
// It is the whole reason `razorpay` is on COUNTER_TENDER_METHODS again: a
// method belongs on an allowlist only once the action behind it can settle it.
// ---------------------------------------------------------------------------

describe("verifyGatewayTenders", () => {
  const online = (over: Record<string, unknown> = {}) =>
    [{ method: "razorpay", amount: 100, reference: "pay_1", ...over }] as never;

  it("passes a captured payment for the exact amount", async () => {
    expect(await verifyGatewayTenders("store-1", online())).toBeNull();
  });

  it("★ ignores tenders with nothing to verify", async () => {
    // Cash, and the external-terminal card/upi records, have no gateway record
    // to read back. Asking about them would fail every ordinary sale.
    const res = await verifyGatewayTenders("store-1", [
      { method: "cash", amount: 50, tendered: 50 },
      { method: "card", amount: 50, reference: "slip-7" },
    ] as never);
    expect(res).toBeNull();
    expect(rzpFetchPayment).not.toHaveBeenCalled();
  });

  it("★★ refuses a claimed amount above what was captured", async () => {
    // captured() is ₹100; claiming ₹500 against it must not settle.
    const res = await verifyGatewayTenders("store-1", online({ amount: 500 }));
    expect(res).toMatch(/doesn't match/i);
  });

  it("★ refuses a gateway tender carrying no reference", async () => {
    const res = await verifyGatewayTenders("s", online({ reference: "  " }));
    expect(res).toMatch(/missing its reference/i);
    expect(rzpFetchPayment).not.toHaveBeenCalled();
  });

  it("★★ refuses a payment that already settled something", async () => {
    // A captured payment stays captured, so verification alone would pass it
    // every time — only this stops one payment settling two transactions.
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "op-existing" }]] });
    const res = await verifyGatewayTenders("store-1", online());
    expect(res).toMatch(/already been used/i);
    expect(rzpFetchPayment).not.toHaveBeenCalled();
  });

  it("★★ refuses when the replay lookup itself fails", async () => {
    // Cannot prove it is unused ⇒ do not accept it. The money is captured and
    // safe; completing is the only irreversible option.
    const mock = makeDbMock({ selectQueue: [[]] });
    mock.db.select = () => {
      throw new Error("db down");
    };
    dbHolder.current = mock;
    expect(await verifyGatewayTenders("store-1", online())).toMatch(
      /couldn't check/i,
    );
  });

  it("★ checks EVERY gateway leg, not just the first", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    await verifyGatewayTenders("store-1", [
      { method: "razorpay", amount: 100, reference: "pay_1" },
      { method: "razorpay", amount: 100, reference: "pay_2" },
    ] as never);
    expect(vi.mocked(rzpFetchPayment).mock.calls.map((c) => c[1])).toEqual([
      "pay_1",
      "pay_2",
    ]);
  });
});
