/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  getCurrentStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("./platform", () => ({ getPlatformViewer: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  offerCompPlan,
  withdrawCompOffer,
  activateCompPlan,
} from "./comp-plan-actions";
import { getPlatformViewer } from "./platform";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { planEvents, stores } from "@/drizzle/schema";

const SUPERADMIN = { role: "superadmin", email: "ops@storemink.com" } as any;
const MERCHANT = { uid: "u1", email: "owner@acme.com" };

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ returning: [{ id: "store-1" }] });
  vi.mocked(getPlatformViewer).mockResolvedValue(SUPERADMIN);
  vi.mocked(getManagerIdentity).mockResolvedValue(MERCHANT as any);
});

describe("offerCompPlan — operator grant", () => {
  it("★ refuses anyone who is not a platform superadmin", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue({ role: "operator" } as any);
    const res = await offerCompPlan("store-1", {
      plan: "pro",
      durationDays: 30,
    });
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ refuses a comp onto free — a gift must be an upgrade", async () => {
    const res = await offerCompPlan("store-1", {
      plan: "free",
      durationDays: 30,
    });
    expect(res.error).toMatch(/Basic or Pro/);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("bounds the duration", async () => {
    for (const d of [0, -1, 366, 1.5, Number.NaN]) {
      expect(
        (await offerCompPlan("store-1", { plan: "pro", durationDays: d }))
          .error,
      ).toMatch(/between 1 and 365/);
    }
  });

  it("★★ writes the DURATION only — never the window", async () => {
    // The operator grants how long; the merchant's acceptance decides when.
    const res = await offerCompPlan("store-1", {
      plan: "pro",
      durationDays: 30,
    });
    expect(res.success).toBe(true);
    const set = dbHolder.current.calls.set[0];
    expect(set.compPlan).toBe("pro");
    expect(set.compDurationDays).toBe(30);
    expect(set).not.toHaveProperty("compStartsAt");
    expect(set).not.toHaveProperty("compExpiresAt");
  });

  it("★★ NEVER touches the paid entitlement", async () => {
    await offerCompPlan("store-1", { plan: "pro", durationDays: 30 });
    const set = dbHolder.current.calls.set[0];
    for (const k of ["plan", "planSource", "planExpiresAt"]) {
      expect(set).not.toHaveProperty(k);
    }
    // ...and nothing billing-shaped was written at all.
    expect(dbHolder.current.calls.update).toEqual([stores]);
  });

  it("reports a refused claim as an already-running comp", async () => {
    dbHolder.current = makeDbMock({ returningQueue: [[]] });
    const res = await offerCompPlan("store-1", {
      plan: "pro",
      durationDays: 30,
    });
    expect(res.error).toMatch(/already has a comped plan/i);
  });

  it("★ audits as source 'operator' — 'comp' is a different vocabulary", async () => {
    // plan_events.source is operator|billing|system; stores.plan_source is
    // comp|paid|trial. Mixing them is rejected by the CHECK (CODEBASE.md §15).
    await offerCompPlan("store-1", { plan: "pro", durationDays: 30 });
    expect(dbHolder.current.calls.insert[0]).toBe(planEvents);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      source: "operator",
      toPlan: "pro",
      actor: "ops@storemink.com",
    });
  });
});

describe("withdrawCompOffer", () => {
  it("refuses a non-superadmin", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(null as any);
    expect((await withdrawCompOffer("store-1")).error).toMatch(/superadmin/i);
  });

  it("reports nothing to withdraw when the claim matches no row", async () => {
    dbHolder.current = makeDbMock({ returningQueue: [[]] });
    expect((await withdrawCompOffer("store-1")).error).toMatch(
      /no pending offer/i,
    );
  });

  it("clears only the offer fields", async () => {
    await withdrawCompOffer("store-1");
    expect(dbHolder.current.calls.set[0]).toEqual({
      compPlan: null,
      compDurationDays: null,
      compOfferedAt: null,
    });
  });
});

describe("activateCompPlan — merchant acceptance", () => {
  beforeEach(() => {
    dbHolder.current = makeDbMock({
      returning: [{ plan: "pro", expiresAt: "2026-10-06T00:00:00.000Z" }],
    });
  });

  it("★★ TAKES NO ARGUMENTS — the plan cannot come from the browser", () => {
    // The whole security boundary. If this ever gains a parameter, a merchant
    // can post "pro" and grant it to themselves.
    expect(activateCompPlan.length).toBe(0);
  });

  it("refuses a caller without manage permission", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null as any);
    const res = await activateCompPlan();
    expect(res.error).toMatch(/permission/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("opens the window from the DATABASE clock", async () => {
    const res = await activateCompPlan();
    expect(res.success).toBe(true);
    expect(res.plan).toBe("pro");
    const set = dbHolder.current.calls.set[0];
    // Both are SQL expressions, not JS Dates — a container clock must not
    // decide when a merchant's free month ends.
    expect(set.compStartsAt).toBeTruthy();
    expect(typeof set.compStartsAt).not.toBe("string");
    expect(set.compExpiresAt).toBeTruthy();
  });

  it("★★ NEVER touches the paid entitlement", async () => {
    await activateCompPlan();
    const set = dbHolder.current.calls.set[0];
    for (const k of ["plan", "planSource", "planExpiresAt"]) {
      expect(set).not.toHaveProperty(k);
    }
  });

  it("★ a second click claims zero rows and is reported, not repeated", async () => {
    dbHolder.current = makeDbMock({ returningQueue: [[]] });
    const res = await activateCompPlan();
    expect(res.success).toBeUndefined();
    expect(res.error).toMatch(/no longer available/i);
  });

  it("★ a withdrawn offer cannot be accepted from a stale page", async () => {
    // Same conditional claim covers it: the write re-reads the grant.
    dbHolder.current = makeDbMock({ returningQueue: [[]] });
    expect((await activateCompPlan()).error).toMatch(/no longer available/i);
  });
});
