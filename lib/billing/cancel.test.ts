/* eslint-disable @typescript-eslint/no-explicit-any */
// Cancelling, resuming, and reading the subscription.
//
// The old path's cancel could fail for the PROVIDER's reasons — most often
// "Subscription cannot be cancelled since no billing cycle is going on", which
// hit anyone cancelling before their first charge and left them stuck. Here it is
// a flag, so the interesting cases are all ours: cancel once, keep what was paid
// for, withdraw the standing permission to debit, and never claim autopay is back.

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

const receipts = vi.hoisted(() => ({ notifySubscriptionCancelled: vi.fn() }));
vi.mock("./receipts", () => receipts);

import {
  cancelAtPeriodEnd,
  getSubscriptionView,
  resumeSubscription,
} from "./cancel";

const STORE = "store-1";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_END = "2026-09-16T00:00:00.000Z";

function seed(rows: any[][], returning?: any[]) {
  dbHolder.current = makeDbMock({
    selectQueue: rows,
    ...(returning ? { returning } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cancelAtPeriodEnd", () => {
  const args = { storeId: STORE, now: NOW };

  function seedActive(over: Record<string, unknown> = {}) {
    seed([
      [
        {
          plan: "pro",
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          mandateId: "mand-1",
          ...over,
        },
      ],
    ]);
  }

  it("★★ sets the flag rather than calling a gateway, and keeps the paid period", async () => {
    seedActive();
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.accessUntil).toBe(PERIOD_END);
    expect(dbHolder.current.calls.set[0].cancelAtPeriodEnd).toBe(true);
  });

  it("★★ WITHDRAWS the standing permission to debit", async () => {
    // A live mandate is permission to take money. Someone who cancelled has
    // withdrawn it, and "it doesn't matter, nothing will charge it" is the
    // reasoning that turns one bug into a debit.
    seedActive();
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.mandateRevoked).toBe(true);
    expect(
      dbHolder.current.calls.set.some((s: any) => s.status === "revoked"),
    ).toBe(true);
  });

  it("★★ CONFIRMS it, naming the plan and what they keep", async () => {
    // A cancellation with no acknowledgement leaves the merchant unsure it took.
    seedActive({ plan: "pro" });
    await cancelAtPeriodEnd(args);
    expect(receipts.notifySubscriptionCancelled).toHaveBeenCalledWith({
      storeId: STORE,
      plan: "pro",
      accessUntil: PERIOD_END,
    });
  });

  it("★ says nothing when there was nothing to cancel", async () => {
    seed([[]]);
    await cancelAtPeriodEnd(args);
    expect(receipts.notifySubscriptionCancelled).not.toHaveBeenCalled();
  });

  it("★ clears any booked change — it is moot once they are leaving", async () => {
    seedActive();
    await cancelAtPeriodEnd(args);
    const set = dbHolder.current.calls.set[0];
    expect(set.scheduledPlan).toBeNull();
    expect(set.scheduledPeriod).toBeNull();
    expect(set.scheduledLocations).toBeNull();
  });

  it("★ refuses a second cancel", async () => {
    seedActive({ cancelAtPeriodEnd: true });
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(false);
    expect(dbHolder.current.calls.update.length).toBe(0);
  });

  it("★★ refuses when the CLAIM finds nothing, not just when the read said so", async () => {
    // Two clicks racing: the read passes for both, and the conditional update is
    // what decides. Without it the second would report a fresh cancellation.
    seed([
      [
        {
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          mandateId: null,
        },
      ],
    ]);
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            state: "active",
            currentPeriodEnd: PERIOD_END,
            cancelAtPeriodEnd: false,
            mandateId: null,
          },
        ],
      ],
      returning: [], // the claim matched no rows
    });
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/already cancelling/i);
  });

  it("refuses when there is nothing to cancel", async () => {
    seed([[]]);
    expect((await cancelAtPeriodEnd(args)).ok).toBe(false);
  });

  it("★ refuses a subscription that already ended", async () => {
    seedActive({ state: "cancelled" });
    expect((await cancelAtPeriodEnd(args)).ok).toBe(false);
  });

  it("★ cancels a PAST_DUE subscription too — they are still entitled to stop", async () => {
    seedActive({ state: "past_due" });
    expect((await cancelAtPeriodEnd(args)).ok).toBe(true);
  });

  it("★ no cycle yet means no promise of access", async () => {
    // Between authorising and the first charge there is nothing paid for, so
    // promising a plan until a date would be untrue.
    seedActive({ currentPeriodEnd: null, state: "active" });
    const res = await cancelAtPeriodEnd(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.accessUntil).toBeNull();
  });

  it("★ refuses on a read failure rather than guessing", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    expect((await cancelAtPeriodEnd(args)).ok).toBe(false);
  });
});

describe("resumeSubscription", () => {
  const args = { storeId: STORE, now: NOW };

  it("clears the flag", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[]],
      returning: [{ mandateId: null }],
    });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    expect(dbHolder.current.calls.set[0].cancelAtPeriodEnd).toBe(false);
  });

  it("★★ does NOT claim autopay is back — the mandate was revoked", async () => {
    // Saying otherwise has the merchant expect a charge that never comes, and be
    // downgraded for it.
    dbHolder.current = makeDbMock({
      selectQueue: [[]], // mandateIsActive finds nothing
      returning: [{ mandateId: "mand-1" }],
    });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.autopay).toBe(false);
  });

  it("reports autopay when a mandate really is active", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "mand-1" }]],
      returning: [{ mandateId: "mand-1" }],
    });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.autopay).toBe(true);
  });

  it("★★ refuses one that already ENDED, rather than reviving a dead plan", async () => {
    // Past `endSubscription` the state is `cancelled` and the cycle is gone;
    // flipping the flag back would leave a paid state with no period (which the
    // cycle_present CHECK forbids) and claim to restore a plan already taken.
    dbHolder.current = makeDbMock({ selectQueue: [[]], returning: [] });
    const res = await resumeSubscription(args);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/Subscribe again/i);
  });
});

describe("getSubscriptionView", () => {
  it("★★ autopay is FALSE for a mandate above the AFA-exempt limit", async () => {
    // The reassuring half of the Plans page. A ₹43,000 ceiling looks like the
    // strongest possible autopay and is the opposite: RBI caps an unattended
    // debit at ₹15,000 on cards and UPI alike, so a mandate sized past it can
    // never carry a renewal at all. Every yearly subscriber saw autopay ON
    // while each renewal quietly went to a manual invoice.
    seed([
      [
        {
          plan: "pro",
          period: "yearly",
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: "mand-1",
          mandateStatus: "active",
          mandateMaxPaise: 43_000_00,
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).autopay).toBe(false);
  });

  it("★ autopay is FALSE for a revoked mandate, whatever its ceiling", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "monthly",
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: "mand-1",
          mandateStatus: "revoked",
          mandateMaxPaise: 5_000_00,
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).autopay).toBe(false);
  });

  it("maps our state vocabulary through, not Razorpay's", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "yearly",
          state: "past_due",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: "basic",
          scheduledPeriod: "monthly",
          scheduledLocations: 1,
          mandateId: "mand-1",
          mandateStatus: "active",
          mandateMaxPaise: 5_000_00,
        },
      ],
    ]);
    const v = await getSubscriptionView(STORE);
    expect(v).toMatchObject({
      plan: "pro",
      period: "yearly",
      status: "past_due",
      currentEnd: PERIOD_END,
      scheduledPlan: "basic",
      scheduledPeriod: "monthly",
      scheduledLocations: 1,
      autopay: true,
      active: true,
    });
  });

  it("★ autopay is FALSE when the mandate is not active", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "monthly",
          state: "active",
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: "mand-1",
          mandateStatus: "revoked",
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).autopay).toBe(false);
  });

  it("★ a CANCELLED subscription is not `active` — no controls to offer", async () => {
    seed([
      [
        {
          plan: "pro",
          period: "monthly",
          state: "cancelled",
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          scheduledPlan: null,
          scheduledPeriod: null,
          scheduledLocations: null,
          mandateId: null,
          mandateStatus: null,
        },
      ],
    ]);
    expect((await getSubscriptionView(STORE)).active).toBe(false);
  });

  it("★★ returns a NEUTRAL view on a read failure, never throws", async () => {
    // The page also renders AI usage and the plan list; a billing hiccup should
    // cost the subscription card, not the whole page.
    dbHolder.current = makeDbMock({ selectQueue: [] });
    dbHolder.current.db.select = () => {
      throw new Error("db down");
    };
    const v = await getSubscriptionView(STORE);
    expect(v.active).toBe(false);
    expect(v.plan).toBeNull();
  });

  it("returns a neutral view when there is no subscription", async () => {
    seed([[]]);
    expect((await getSubscriptionView(STORE)).status).toBeNull();
  });
});
