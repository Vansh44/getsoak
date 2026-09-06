/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock, sqlText } from "@/app/actions/_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/store/resolve", () => ({
  STORE_TAG: "stores",
  getCurrentStoreId: vi.fn(),
}));
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => {}),
  emitEvent: vi.fn(),
}));
vi.mock("@/lib/email/billing-emails", () => ({
  resolveBillingEmail: vi.fn(),
  sendBillingEmail: vi.fn(async () => {}),
  manageUrl: vi.fn(
    (slug: string) => `https://${slug}.storemink.com/dashboard/plans`,
  ),
  planDowngradedTemplate: vi.fn((a: any) => ({ subject: "Plan lapsed", ...a })),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { GET, POST } from "./route";
import { revalidateTag } from "next/cache";
import { recordEvent } from "@/lib/notifications/record";
import {
  resolveBillingEmail,
  sendBillingEmail,
} from "@/lib/email/billing-emails";
import { planEvents } from "@/drizzle/schema";
import { EXPIRY_WARN_DAYS } from "@/lib/plans";

function req(auth?: string): Request {
  return new Request("https://storemink.com/api/cron/plan-expiry", {
    headers: auth ? { authorization: auth } : {},
  });
}

/**
 * The route runs: the COMP sweep (one conditional UPDATE ... RETURNING, always),
 * then 1 lapsed-select, then (if any lapsed) the paid update, then one
 * warn-select per EXPIRY_WARN_DAYS horizon.
 *
 * ★ The comp sweep is a single raw-SQL `UPDATE ... FROM stores old ... RETURNING`
 * (Postgres RETURNING gives the NEW row, so the plan that ENDED has to come
 * from a self-join snapshot). It therefore consumes an `executeQueue` entry,
 * not a `returningQueue` one.
 */
function queues(lapsed: any[], warnRows: any[][] = []) {
  const warns = EXPIRY_WARN_DAYS.map((_, i) => warnRows[i] ?? []);
  return [lapsed, ...warns];
}

// Durably flips expired timed plans to free (§15). effectivePlan already treats
// a lapsed plan as free at READ time; this job makes the row itself honest and
// writes the audit trail.
describe("/api/cron/plan-expiry", () => {
  const OLD = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
    dbHolder.current = makeDbMock({ selectQueue: queues([]) });
    vi.mocked(resolveBillingEmail).mockResolvedValue(null as any);
  });

  afterEach(() => {
    if (OLD === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = OLD;
  });

  it("refuses a request with no Authorization header", async () => {
    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("refuses a wrong secret", async () => {
    expect((await GET(req("Bearer nope"))).status).toBe(401);
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    expect((await GET(req("Bearer undefined"))).status).toBe(401);
  });

  it("reports nothing expired when no plan has lapsed", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([]),
      executeQueue: [[]], // comp sweep clears nothing
    });

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      expired: 0,
      compsEnded: 0,
    });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("does not run the PAID update when nothing has lapsed", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([]),
      executeQueue: [[]],
    });

    await GET(req("Bearer s3cret"));

    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★★ ends a lapsed comp WITHOUT touching the paid plan", async () => {
    // docs/comped-plans-spec.md §3.2 — the failure the overlay exists to
    // prevent. This store pays for Basic; only the comp columns may be cleared,
    // or it lands on Free while its subscription is live and paid.
    dbHolder.current = makeDbMock({
      selectQueue: queues([]),
      executeQueue: [[{ id: "s1", comp_plan_before: "pro", plan: "basic" }]],
    });

    const res = await GET(req("Bearer s3cret"));

    expect(await res.json()).toMatchObject({ compsEnded: 1, expired: 0 });

    const text = sqlText(dbHolder.current.calls.execute[0]);
    // Only the comp columns are set...
    expect(text).toContain("comp_plan = null");
    expect(text).toContain("comp_expires_at = null");
    // ...and the paid entitlement is never assigned. THE regression this
    // guards: writing `plan = 'free'` here drops a live paid subscriber.
    expect(text).not.toMatch(/set[\s\S]*\bs\.plan\s*=/);
    expect(text).not.toContain("plan_expires_at = null");
    // The old-row snapshot is what lets the notice name the plan that ended.
    expect(text).toContain("old.comp_plan");
  });

  it("★ tells the merchant which plan they fall BACK to, not the one they lost", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([]),
      executeQueue: [[{ id: "s1", comp_plan_before: "pro", plan: "basic" }]],
    });

    await GET(req("Bearer s3cret"));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "store.comp_ended",
        storeId: "s1",
        payload: { comp_plan: "Pro", plan: "Basic" },
      }),
    );
  });

  it("flips a lapsed plan to free and clears the expiry", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      executeQueue: [[]], // comp sweep clears nothing
      returning: [{ id: "s1" }],
    });

    const res = await GET(req("Bearer s3cret"));

    expect(await res.json()).toMatchObject({ ok: true, expired: 1 });
    expect(dbHolder.current.calls.set[0]).toEqual({
      plan: "free",
      planExpiresAt: null,
    });
  });

  it("audits the plan each store fell FROM", async () => {
    // The UPDATE returns new values, so the snapshot is taken first — auditing
    // off the update would record every store as falling from "free".
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      executeQueue: [[]], // comp sweep clears nothing
      returning: [{ id: "s1" }],
    });

    await GET(req("Bearer s3cret"));

    expect(dbHolder.current.calls.insert[0]).toBe(planEvents);
    expect(dbHolder.current.calls.values[0]).toEqual([
      {
        storeId: "s1",
        fromPlan: "pro",
        toPlan: "free",
        source: "system",
        actor: "plan-expiry-cron",
        note: "plan expired",
      },
    ]);
  });

  it("audits ONLY the stores the UPDATE actually flipped", async () => {
    // A store whose plan was extended between the snapshot and the UPDATE is
    // left alone by the re-checked WHERE; auditing it would record a downgrade
    // that never happened, and email the merchant about it.
    dbHolder.current = makeDbMock({
      selectQueue: queues([
        { id: "s1", plan: "pro" },
        { id: "s2", plan: "basic" },
      ]),
      returning: [{ id: "s1" }],
    });

    const res = await GET(req("Bearer s3cret"));

    expect(await res.json()).toMatchObject({ expired: 1 });
    expect(dbHolder.current.calls.values[0]).toHaveLength(1);
    expect(dbHolder.current.calls.values[0][0].storeId).toBe("s1");
  });

  it("reports zero expired when the UPDATE flipped nothing", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      returning: [],
    });

    const res = await GET(req("Bearer s3cret"));

    expect(await res.json()).toMatchObject({ expired: 0 });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("busts the store cache so the plan gates take effect at once", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      returning: [{ id: "s1" }],
    });

    await GET(req("Bearer s3cret"));

    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
  });

  it("emails each downgraded merchant", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      returning: [{ id: "s1" }],
    });
    vi.mocked(resolveBillingEmail).mockResolvedValue({
      email: "owner@acme.com",
      storeName: "Acme",
      slug: "acme",
    } as any);

    await GET(req("Bearer s3cret"));

    expect(sendBillingEmail).toHaveBeenCalledWith(
      "owner@acme.com",
      expect.objectContaining({ storeName: "Acme" }),
    );
  });

  it("skips the email when the store has no billing address on file", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      returning: [{ id: "s1" }],
    });
    vi.mocked(resolveBillingEmail).mockResolvedValue(null as any);

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(sendBillingEmail).not.toHaveBeenCalled();
  });

  it("still reports the flip when the audit insert fails", async () => {
    // Best-effort audit trail — the flip itself is the source of truth, and a
    // failed audit row must not make the cron look like it did nothing.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      returning: [{ id: "s1" }],
      failInsertFor: [planEvents],
    });

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ expired: 1 });
    expect(revalidateTag).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("answers 500 when the read/update transaction fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.current = makeDbMock();
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("connection reset");
    });

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "update failed" });
    spy.mockRestore();
  });

  it("logs a non-Error read/update rejection as-is", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.current = makeDbMock();
    dbHolder.current.db.select = vi.fn(() => {
      throw "deadlock";
    });

    await GET(req("Bearer s3cret"));

    expect(spy).toHaveBeenCalledWith("plan-expiry (read/update):", "deadlock");
    spy.mockRestore();
  });

  it("logs a non-Error audit rejection as-is", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.current = makeDbMock({
      selectQueue: queues([{ id: "s1", plan: "pro" }]),
      returning: [{ id: "s1" }],
    });
    dbHolder.current.db.insert = vi.fn(() => {
      throw "audit deadlock";
    });

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith("plan-expiry (audit):", "audit deadlock");
    spy.mockRestore();
  });

  describe("expiry warnings", () => {
    // ⚠ KNOWN DEFECT, pinned here rather than hidden: `handle` returns early at
    // `if (!lapsed.length)` — BEFORE it ever calls warnExpiringPlans. So the
    // 7-day and 1-day "your plan is expiring" warnings go out ONLY on a day
    // when some OTHER store's plan actually lapsed. Expiries are sparse, so in
    // practice most merchants get no warning before losing their paid
    // features. Every test below therefore has to supply a lapsed store just to
    // reach the warning code at all — which is the smell.
    //
    // The fix is to move the `warned` call above that early return (and include
    // it in the zero-lapsed response). Not applied here: this is a live billing
    // path and the task was coverage, not behaviour changes.
    const LAPSED = [{ id: "s1", plan: "pro" }];

    it("does NOT warn anyone on a day when no plan lapsed (the defect)", async () => {
      const warnRows = EXPIRY_WARN_DAYS.map((_, i) =>
        i === 0 ? [{ id: "s5", plan: "pro", planExpiresAt: "2026-08-13" }] : [],
      );
      dbHolder.current = makeDbMock({
        selectQueue: queues([], warnRows),
        executeQueue: [[]],
      });

      const res = await GET(req("Bearer s3cret"));

      expect(await res.json()).toEqual({ ok: true, expired: 0, compsEnded: 0 });
      // The store IS inside the 7-day window and still hears nothing.
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it("warns a store approaching its expiry, once per horizon band", async () => {
      const warnRows = EXPIRY_WARN_DAYS.map((_, i) =>
        i === 0
          ? [{ id: "s5", plan: "pro", planExpiresAt: "2026-08-13T00:00:00Z" }]
          : [],
      );
      dbHolder.current = makeDbMock({
        selectQueue: queues(LAPSED, warnRows),
        returning: [{ id: "s1" }],
      });

      const res = await GET(req("Bearer s3cret"));

      expect(await res.json()).toMatchObject({ warned: 1 });
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "plan.expiring",
          storeId: "s5",
          actor: { type: "system" },
          payload: expect.objectContaining({
            daysLeft: EXPIRY_WARN_DAYS[0],
            expiresOn: "2026-08-13T00:00:00Z",
          }),
        }),
      );
    });

    it("uses recordEvent, not emitEvent", async () => {
      // A cron response is already gone by the time after() would run.
      const { emitEvent } = await import("@/lib/notifications/record");
      const warnRows = EXPIRY_WARN_DAYS.map((_, i) =>
        i === 0 ? [{ id: "s5", plan: "pro", planExpiresAt: "2026-08-13" }] : [],
      );
      dbHolder.current = makeDbMock({
        selectQueue: queues(LAPSED, warnRows),
        returning: [{ id: "s1" }],
      });

      await GET(req("Bearer s3cret"));

      expect(recordEvent).toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it("checks every configured horizon", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: queues(LAPSED),
        returning: [{ id: "s1" }],
      });

      await GET(req("Bearer s3cret"));

      // one lapsed-select + one select per horizon
      expect(dbHolder.current.calls.select).toHaveLength(
        1 + EXPIRY_WARN_DAYS.length,
      );
    });

    it("copes with a due row carrying no expiry date", async () => {
      const warnRows = EXPIRY_WARN_DAYS.map((_, i) =>
        i === 0 ? [{ id: "s5", plan: "pro", planExpiresAt: null }] : [],
      );
      dbHolder.current = makeDbMock({
        selectQueue: queues(LAPSED, warnRows),
        returning: [{ id: "s1" }],
      });

      await GET(req("Bearer s3cret"));

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ expiresOn: "" }),
        }),
      );
    });

    it("carries on to the next horizon when one warn query fails", async () => {
      // A failed horizon must not cost the others their warnings.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({
        selectQueue: queues(LAPSED),
        returning: [{ id: "s1" }],
      });
      let call = 0;
      const realSelect = dbHolder.current.db.select;
      dbHolder.current.db.select = vi.fn((p: any) => {
        call++;
        if (call === 2) throw new Error("warn query failed");
        return realSelect(p);
      });

      const res = await GET(req("Bearer s3cret"));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, warned: 0 });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("plan-expiry (warn"),
        "warn query failed",
      );
      spy.mockRestore();
    });

    it("logs a non-Error warn rejection as-is", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({
        selectQueue: queues(LAPSED),
        returning: [{ id: "s1" }],
      });
      let call = 0;
      const realSelect = dbHolder.current.db.select;
      dbHolder.current.db.select = vi.fn((p: any) => {
        call++;
        if (call === 2) throw "warn deadlock";
        return realSelect(p);
      });

      const res = await GET(req("Bearer s3cret"));

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("plan-expiry (warn"),
        "warn deadlock",
      );
      spy.mockRestore();
    });

    it("reports zero warned when nothing is approaching expiry", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: queues(LAPSED),
        returning: [{ id: "s1" }],
      });

      const res = await GET(req("Bearer s3cret"));

      expect(await res.json()).toMatchObject({ warned: 0 });
      expect(recordEvent).not.toHaveBeenCalled();
    });
  });

  it("serves POST identically to GET", async () => {
    const res = await POST(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("refuses an unauthorized POST too", async () => {
    expect((await POST(req())).status).toBe(401);
  });
});
