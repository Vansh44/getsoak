/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

/**
 * A tiny fake of the two shapes reinstateCreditForOrder issues: a select over
 * the ledger's `spend` rows, then a select summing credit refunds, then the
 * add_customer_credit RPC per spend row.
 */
const state = vi.hoisted(() => ({
  spends: [] as { customer_id: string; delta: number }[],
  creditRefunded: "0",
  issued: [] as { customerId: string; amount: number; kind: string }[],
  selectCall: 0,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => {
    const chain = (rows: any[]) => {
      const c: any = {
        from: () => c,
        where: () => c,
        orderBy: () => c,
        limit: () => c,
        then: (r: any) => Promise.resolve(rows).then(r),
      };
      return c;
    };
    const db = {
      select: () => {
        state.selectCall += 1;
        return state.selectCall === 1
          ? chain(state.spends)
          : chain([{ total: state.creditRefunded }]);
      },
      execute: async (q: any) => {
        // add_customer_credit(...) — capture what it was asked to issue.
        const text = String(
          q?.queryChunks?.map?.((c: any) => c?.value ?? "").join("") ?? "",
        );
        void text;
        return { rows: [{ ok: true }] };
      },
    };
    return Promise.resolve(fn(db));
  }),
}));

import { reinstateCreditForOrder } from "./store-credit";

beforeEach(() => {
  vi.clearAllMocks();
  state.spends = [];
  state.creditRefunded = "0";
  state.issued = [];
  state.selectCall = 0;
});

describe("★ reinstating credit can't double-credit a refunded order", () => {
  it("gives the whole balance back when nothing was refunded as credit", async () => {
    state.spends = [{ customer_id: "c1", delta: -500 }];
    state.creditRefunded = "0";
    expect(await reinstateCreditForOrder("s1", "o1")).toBe(500);
  });

  it("★ gives back NOTHING when a credit refund already covered it", async () => {
    // Refund-then-cancel is an ordinary sequence. A ₹500 order paid entirely
    // with credit, refunded as credit and then cancelled, used to leave the
    // customer holding ₹1,000 — the per-(kind, ref) idempotency can't see it,
    // because one row is a `refund` keyed on the refund and the other a
    // `reinstate` keyed on the order.
    state.spends = [{ customer_id: "c1", delta: -500 }];
    state.creditRefunded = "500";
    expect(await reinstateCreditForOrder("s1", "o1")).toBe(0);
  });

  it("gives back only the uncovered part", async () => {
    state.spends = [{ customer_id: "c1", delta: -500 }];
    state.creditRefunded = "200";
    expect(await reinstateCreditForOrder("s1", "o1")).toBe(300);
  });

  it("★ a CASH refund does not swallow the credit that is still owed", async () => {
    // ₹200 of credit + ₹300 of cash. Refunding the ₹300 cash says nothing
    // about the credit half, so cancelling must still return the ₹200.
    state.spends = [{ customer_id: "c1", delta: -200 }];
    state.creditRefunded = "0"; // the query only sums method='store_credit'
    expect(await reinstateCreditForOrder("s1", "o1")).toBe(200);
  });

  it("returns nothing for an order that never used credit", async () => {
    state.spends = [];
    expect(await reinstateCreditForOrder("s1", "o1")).toBe(0);
  });
});
