// The billing cron.
//
// Two things here are security- or money-critical rather than cosmetic:
//
//   • the auth gate FAILS CLOSED on a missing secret — this endpoint charges
//     merchants and removes their plans, so an unset CRON_SECRET must not leave
//     it open;
//   • with no gateway configured, collection is SKIPPED rather than attempted,
//     because a stub that always failed would create payment attempts that can
//     never settle.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const worker = vi.hoisted(() => ({
  RENEWAL_BATCH: 50,
  collectDueRenewals: vi.fn(),
  evaluateCycleTurns: vi.fn(),
  downgradeExpired: vi.fn(),
}));
vi.mock("@/lib/billing/renewal-worker", () => worker);

const gateway = vi.hoisted(() => ({
  getRecurringCharge: vi.fn(),
  chargeUnavailableReason: vi.fn(),
}));
vi.mock("@/lib/billing/gateway", () => gateway);

const pricing = vi.hoisted(() => ({
  getPlanPricingLive: vi.fn(),
  getExtraLocationPricingLive: vi.fn(),
}));
vi.mock("@/lib/plans/pricing", () => pricing);

import { GET, POST } from "./route";

const SECRET = "s3cret";

function req(auth?: string) {
  return new Request("https://storemink.com/api/cron/billing", {
    headers: auth ? { authorization: auth } : {},
  });
}

const EMPTY_COLLECT = {
  considered: 0,
  collected: 0,
  failed: 0,
  pendingReconcile: 0,
  manualRequired: 0,
  errors: 0,
};
const EMPTY_EVAL = {
  advanced: 0,
  graced: 0,
  waiting: 0,
  ended: 0,
  errors: 0,
};
const EMPTY_DOWN = { downgraded: 0, shiftsClosed: 0, errors: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  worker.collectDueRenewals.mockResolvedValue({ ...EMPTY_COLLECT });
  worker.evaluateCycleTurns.mockResolvedValue({ ...EMPTY_EVAL });
  worker.downgradeExpired.mockResolvedValue({ ...EMPTY_DOWN });
  gateway.getRecurringCharge.mockReturnValue(vi.fn());
  gateway.chargeUnavailableReason.mockReturnValue(null);
  pricing.getPlanPricingLive.mockResolvedValue({
    free: { monthlyInr: 0, yearlyInr: 0 },
    basic: { monthlyInr: 1500, yearlyInr: 15000 },
    pro: { monthlyInr: 5000, yearlyInr: 50000 },
  });
  pricing.getExtraLocationPricingLive.mockResolvedValue({
    monthlyInr: 1000,
    yearlyInr: 10000,
  });
});

describe("auth", () => {
  it("401s without a bearer token", async () => {
    expect((await GET(req())).status).toBe(401);
  });

  it("401s on a wrong token", async () => {
    expect((await GET(req("Bearer nope"))).status).toBe(401);
  });

  it("★★ FAILS CLOSED when CRON_SECRET is unset", async () => {
    // This endpoint charges merchants and removes their plans. An unset secret
    // must never make it public.
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer anything"))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(worker.collectDueRenewals).not.toHaveBeenCalled();
  });

  it("runs nothing at all when unauthorised", async () => {
    await GET(req("Bearer nope"));
    expect(worker.collectDueRenewals).not.toHaveBeenCalled();
    expect(worker.evaluateCycleTurns).not.toHaveBeenCalled();
    expect(worker.downgradeExpired).not.toHaveBeenCalled();
  });

  it("accepts the correct token on GET and POST", async () => {
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
    expect((await POST(req(`Bearer ${SECRET}`))).status).toBe(200);
  });
});

describe("the three passes", () => {
  it("runs collect, then evaluate, then downgrade — in that order", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const c = worker.collectDueRenewals.mock.invocationCallOrder[0];
    const e = worker.evaluateCycleTurns.mock.invocationCallOrder[0];
    const d = worker.downgradeExpired.mock.invocationCallOrder[0];
    expect(c).toBeLessThan(e);
    expect(e).toBeLessThan(d);
  });

  it("passes ONE `now` to every pass, so they agree on the instant", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const n1 = worker.collectDueRenewals.mock.calls[0][0].now;
    const n2 = worker.evaluateCycleTurns.mock.calls[0][0].now;
    const n3 = worker.downgradeExpired.mock.calls[0][0].now;
    expect(n1).toBe(n2);
    expect(n2).toBe(n3);
  });

  it("★ prices from the LIVE readers, never the cached ones", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const priceFor = worker.collectDueRenewals.mock.calls[0][0].priceFor;
    const p = await priceFor("basic", "yearly");
    expect(p).toEqual({
      planPaise: 15_000_00,
      locationPaise: 10_000_00,
      planLabel: "Basic",
    });
    expect(pricing.getPlanPricingLive).toHaveBeenCalled();
  });

  it("converts monthly prices to paise", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const priceFor = worker.collectDueRenewals.mock.calls[0][0].priceFor;
    expect(await priceFor("pro", "monthly")).toMatchObject({
      planPaise: 5_000_00,
      locationPaise: 1_000_00,
    });
  });
});

describe("★ collection with no gateway configured", () => {
  beforeEach(() => {
    gateway.getRecurringCharge.mockReturnValue(null);
    gateway.chargeUnavailableReason.mockReturnValue("endpoint not verified");
  });

  it("★★ STILL RUNS pass 1 — it ISSUES the invoice, charging is separate", async () => {
    // Skipping the pass wholesale meant no invoice was ever written: pass 2
    // waited forever, nobody was downgraded, every subscriber got free service
    // past their cycle end, and the manual payment surface had nothing to list.
    await GET(req(`Bearer ${SECRET}`));
    expect(worker.collectDueRenewals).toHaveBeenCalled();
  });

  it("★★ passes charge NULL, so the invoice is issued but never charged", async () => {
    // Deliberately not a stub that fails: an unreachable provider is an UNKNOWN
    // outcome, not a decline, so every attempt would sit in reconciliation
    // forever.
    await GET(req(`Bearer ${SECRET}`));
    expect(worker.collectDueRenewals.mock.calls[0][0].charge).toBeNull();
  });

  it("★ reports collectionSkipped so a green run can't be read as 'collecting'", async () => {
    const body = await (await GET(req(`Bearer ${SECRET}`))).json();
    expect(body.collectionSkipped).toBe("endpoint not verified");
    // The pass still reports its work — issuance happened.
    expect(body.collect).not.toBeNull();
  });

  it("★ still 200s — an unconfigured gateway is not an outage", async () => {
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
  });

  it("★ still runs evaluate and downgrade", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(worker.evaluateCycleTurns).toHaveBeenCalled();
    expect(worker.downgradeExpired).toHaveBeenCalled();
  });
});

describe("status contract", () => {
  it("200s on a clean run", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("★ 503s when a pass reported errors, so Scheduler retries", async () => {
    worker.evaluateCycleTurns.mockResolvedValue({ ...EMPTY_EVAL, errors: 1 });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("503s on a collection error too", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      errors: 2,
    });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(503);
  });

  it("★★ a FAILED PAYMENT is not an error — that merchant simply has not paid", async () => {
    // Returning 5xx here would make Scheduler retry a decline, and a
    // permanently-red job is one nobody reads.
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 3,
      failed: 3,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("★ a downgrade is not an error either", async () => {
    worker.downgradeExpired.mockResolvedValue({
      ...EMPTY_DOWN,
      downgraded: 2,
      shiftsClosed: 2,
    });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
  });

  it("★ reports `more` while a backlog drains, still at 200", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 50,
    });
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect((await res.json()).more).toBe(true);
  });

  it("does not claim `more` on a short batch", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 2,
    });
    expect((await (await GET(req(`Bearer ${SECRET}`))).json()).more).toBe(
      false,
    );
  });

  it("returns the full summary for observability", async () => {
    worker.collectDueRenewals.mockResolvedValue({
      ...EMPTY_COLLECT,
      considered: 4,
      collected: 3,
      manualRequired: 1,
    });
    const body = await (await GET(req(`Bearer ${SECRET}`))).json();
    expect(body.collect).toMatchObject({ collected: 3, manualRequired: 1 });
    expect(body.evaluate).toBeDefined();
    expect(body.downgrade).toBeDefined();
  });
});
