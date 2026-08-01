/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  // platform.ts now imports lib/plans/pricing, whose module scope wraps the
  // price read in unstable_cache. Pass the function straight through so the
  // resolver under test runs uncached.
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
// platform.ts pulls STORE_TAG/FALLBACK_STORE_ID from resolve.ts, whose module
// scope calls unstable_cache — stub the constants instead of loading it.
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));
// Unrelated heavyweight imports of platform.ts — stub so the module loads lean.
vi.mock("@/lib/themes", () => ({ getThemeDefinition: vi.fn() }));
vi.mock("@/lib/themes/apply", () => ({ applyTheme: vi.fn() }));
vi.mock("@/lib/storage/cleanup", () => ({
  deleteStorageUrls: vi.fn(),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
// getPlatformViewer reads platform_admins (select #1), then the action's own
// reads follow — all share this one mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { setStorePlan, grantAiCredits } from "./platform";
import { getServerUser } from "@/lib/auth/server-user";
import { revalidateTag } from "next/cache";

const OPERATOR_EMAIL = "op@storemink.com";
const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

// The platform-viewer gate row (superadmin unless overridden).
function viewer(role: string | null = "superadmin") {
  return role ? [{ email: OPERATOR_EMAIL, role }] : [];
}

// setStorePlan: select #1 = the viewer gate, select #2 = the target store.
function setup(selectQueue: any[][], returning: any[] = [{ id: "s1" }]) {
  dbHolder.current = makeDbMock({ selectQueue, returning });
}

describe("setStorePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    // viewer superadmin, target store on free.
    setup([viewer(), [{ plan: "free", plan_expires_at: null }]]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects a caller who is not a platform admin at all", async () => {
    setup([viewer(null)]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/superadmin/i);
  });

  it("rejects unknown plan ids (incl. the retired 'growth' and 'starter')", async () => {
    setup([viewer()]);
    expect((await setStorePlan("s1", "growth")).error).toMatch(/invalid plan/i);
    setup([viewer()]);
    expect((await setStorePlan("s1", "starter")).error).toMatch(
      /invalid plan/i,
    );
    setup([viewer()]);
    expect((await setStorePlan("s1", "PRO")).error).toMatch(/invalid plan/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects when the store is already on the target plan with the same expiry", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "pro");
    expect(res.error).toMatch(/already on pro/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("allows re-granting the same plan with a different expiry", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "pro", { expiresAt: FUTURE });
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "pro",
      planSource: "comp",
      planExpiresAt: FUTURE,
    });
  });

  it("allows downgrades (operator may set any plan)", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "basic",
      planSource: "comp",
      planExpiresAt: null,
    });

    setup([viewer(), [{ plan: "basic", plan_expires_at: null }]]);
    const res2 = await setStorePlan("s1", "free");
    expect(res2.success).toBe(true);
  });

  it("rejects an unparseable or past expiry", async () => {
    setup([viewer()]);
    expect(
      (await setStorePlan("s1", "pro", { expiresAt: "not-a-date" })).error,
    ).toMatch(/invalid expiry/i);
    setup([viewer()]);
    expect(
      (await setStorePlan("s1", "pro", { expiresAt: PAST })).error,
    ).toMatch(/future/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("sets a timed plan, marks it comp, audits with the expiry, and busts the cache", async () => {
    const res = await setStorePlan("s1", "pro", { expiresAt: FUTURE });
    expect(res.success).toBe(true);

    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "pro",
      planSource: "comp",
      planExpiresAt: FUTURE,
    });
    // Audit row records who did what and until when.
    expect(dbHolder.current.calls.values[0]).toEqual({
      storeId: "s1",
      fromPlan: "free",
      toPlan: "pro",
      source: "operator",
      actor: OPERATOR_EMAIL,
      note: "expires 2030-01-01",
    });
    expect(revalidateTag).toHaveBeenCalled();
  });

  it("an indefinite paid grant audits as such", async () => {
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      toPlan: "basic",
      note: "indefinite",
    });
  });

  it("the free plan never carries an expiry (ignored if sent)", async () => {
    setup([viewer(), [{ plan: "pro", plan_expires_at: null }]]);
    const res = await setStorePlan("s1", "free", { expiresAt: FUTURE });
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "free",
      planSource: "comp",
      planExpiresAt: null,
    });
  });

  it("still succeeds when the audit insert fails (best-effort trail)", async () => {
    setup([viewer(), [{ plan: "free", plan_expires_at: null }]]);
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("boom");
    });
    const res = await setStorePlan("s1", "basic");
    expect(res.success).toBe(true);
  });
});

describe("grantAiCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({
      id: "op-1",
      email: OPERATOR_EMAIL,
      phone: null,
      phoneConfirmed: true,
      metadata: {},
    } as any);
    // viewer superadmin, store exists.
    setup([viewer(), [{ id: "s1" }]]);
  });

  it("rejects a non-superadmin operator", async () => {
    setup([viewer("member")]);
    const res = await grantAiCredits("s1", 50);
    expect(res.error).toMatch(/superadmin/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects non-integer, zero and oversized amounts", async () => {
    setup([viewer()]);
    expect((await grantAiCredits("s1", 0)).error).toMatch(/whole number/i);
    setup([viewer()]);
    expect((await grantAiCredits("s1", 2.5)).error).toMatch(/whole number/i);
    setup([viewer()]);
    expect((await grantAiCredits("s1", 10001)).error).toMatch(/whole number/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("rejects an unknown store", async () => {
    setup([viewer(), []]); // store lookup empty
    const res = await grantAiCredits("nope", 50);
    expect(res.error).toMatch(/not found/i);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("grants through the atomic RPC with the operator email as the audited ref", async () => {
    const res = await grantAiCredits("s1", 50, "onboarding goodwill");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    const params = sqlParamValues(dbHolder.current.calls.execute[0]);
    expect(params).toEqual([
      "s1",
      50,
      "grant",
      OPERATOR_EMAIL,
      "onboarding goodwill",
    ]);
  });

  it("surfaces an RPC failure as a friendly error", async () => {
    dbHolder.current.db.execute = vi.fn(() => {
      throw new Error("boom");
    });
    const res = await grantAiCredits("s1", 50);
    expect(res.error).toMatch(/could not grant/i);
  });
});
