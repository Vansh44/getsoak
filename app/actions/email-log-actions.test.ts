/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

// Both header values live on the holder rather than being re-mocked per test:
// vi.clearAllMocks() clears CALLS but not an implementation installed with
// mockResolvedValue, so a test that overrode `headers` would silently poison
// every test after it.
const headerHolder = vi.hoisted(() => ({
  host: "acme.storemink.com" as string | null,
  forwardedHost: null as string | null,
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (k: string) =>
      k === "x-forwarded-host" ? headerHolder.forwardedHost : headerHolder.host,
  })),
}));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "store-1"),
  STORE_TAG: "stores",
}));
vi.mock("@/app/dashboard/lib/access", () => ({ getViewerAccess: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getEmailLogs, getEmailLog } from "./email-log-actions";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";

const LOG = {
  id: "log-1",
  to: "shopper@example.com",
  from: "hi@storemink.com",
  cc: null,
  bcc: null,
  subject: "Your order",
  mailer: "notification",
  provider: "resend",
  status: "sent",
  error: null,
  createdAt: "2026-08-01T00:00:00Z",
};

function allow(can = true) {
  vi.mocked(getViewerAccess).mockResolvedValue({
    can: vi.fn(() => can),
  } as any);
}

/** getEmailLogs runs 1 page query + 1 total + one tally per status (3). */
function logQueues(rows: any[], total: number, tallies = [0, 0, 0]) {
  return [rows, [{ n: total }], ...tallies.map((n) => [{ n }])];
}

// email-log-actions.ts is the read side of lib/email/send.ts (§24). Scope is
// HOST-derived: the store for a store host, PLATFORM (store_id IS NULL) for
// storemink.com — deliberately NOT getCurrentStoreId() alone, whose never-null
// fallback would show the WholeSip store's mail on the platform console.
describe("email-log-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headerHolder.host = "acme.storemink.com";
    headerHolder.forwardedHost = null;
    dbHolder.current = makeDbMock();
    vi.mocked(getCurrentStoreId).mockResolvedValue("store-1");
    allow(true);
  });

  describe("getEmailLogs", () => {
    it("refuses an anonymous caller", async () => {
      vi.mocked(getViewerAccess).mockResolvedValue(null as any);

      const result = await getEmailLogs();

      expect(result.error).toMatch(/not signed in/i);
      expect(result.rows).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.pageSize).toBe(25);
    });

    it("refuses a viewer without activity.view", async () => {
      allow(false);

      const result = await getEmailLogs();

      expect(result.error).toMatch(/don't have access to activity logs/i);
      expect(result.rows).toEqual([]);
    });

    it("returns rows, total and per-status tallies", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: logQueues([LOG], 42, [40, 1, 1]),
      });

      const result = await getEmailLogs();

      expect(result.rows).toEqual([LOG]);
      expect(result.total).toBe(42);
      expect(result.counts).toEqual({ sent: 40, failed: 1, skipped: 1 });
      expect(result.error).toBeUndefined();
    });

    it("scopes to the host's store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs();

      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "store-1",
      );
    });

    it("scopes to PLATFORM rows on the platform host", async () => {
      // storemink.com must show store_id IS NULL, not the fallback store's mail.
      headerHolder.host = "storemink.com";
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs();

      expect(getCurrentStoreId).not.toHaveBeenCalled();
      expect(sqlParamValues(dbHolder.current.calls.where[0])).not.toContain(
        "store-1",
      );
    });

    it("returns zero counts when the tally queries yield no rows", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], [], [], [], []] });

      const result = await getEmailLogs();

      expect(result.total).toBe(0);
      expect(result.counts).toEqual({ sent: 0, failed: 0, skipped: 0 });
    });

    it("paginates with a 25-row page and reports the page size", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      const result = await getEmailLogs({ page: 3 });

      expect(dbHolder.current.calls.limit[0]).toBe(25);
      expect(dbHolder.current.calls.offset[0]).toBe(50);
      expect(result.pageSize).toBe(25);
    });

    it("clamps a page below 1", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ page: 0 });

      expect(dbHolder.current.calls.offset[0]).toBe(0);
    });

    it("clamps a negative page", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ page: -5 });

      expect(dbHolder.current.calls.offset[0]).toBe(0);
    });

    it("applies a valid status filter", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ status: "failed" });

      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "failed",
      );
    });

    it("ignores a status that is not in the fixed list", async () => {
      // These go straight into a WHERE, so they are validated against a list
      // rather than trusted from the query string.
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ status: "'; DROP TABLE email_logs; --" });

      expect(sqlParamValues(dbHolder.current.calls.where[0])).not.toContain(
        "'; DROP TABLE email_logs; --",
      );
    });

    it("ignores a mailer that is not a known mailer key", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ mailer: "not_a_real_mailer" });

      expect(sqlParamValues(dbHolder.current.calls.where[0])).not.toContain(
        "not_a_real_mailer",
      );
    });

    it("applies a known mailer filter", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ mailer: "coupon_campaign" });

      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "coupon_campaign",
      );
    });

    it("escapes ILIKE wildcards so a_b does not match axb", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ q: "a_b" });

      const params = sqlParamValues(dbHolder.current.calls.where[0]);
      expect(params).toContain("%a\\_b%");
      expect(params).not.toContain("%a_b%");
    });

    it("escapes percent signs and backslashes in the search term", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ q: "50%\\x" });

      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "%50\\%\\\\x%",
      );
    });

    it("caps the search term at 200 characters", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ q: "z".repeat(500) });

      const term = sqlParamValues(dbHolder.current.calls.where[0]).find(
        (p: any) => typeof p === "string" && p.startsWith("%z"),
      );
      expect(term).toBe(`%${"z".repeat(200)}%`);
    });

    it("ignores a whitespace-only search", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ q: "   " });

      expect(
        sqlParamValues(dbHolder.current.calls.where[0]).some(
          (p: any) => typeof p === "string" && p.includes("%"),
        ),
      ).toBe(false);
    });

    it("applies a days window", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ days: 7 });

      const iso = sqlParamValues(dbHolder.current.calls.where[0]).find(
        (p: any) => typeof p === "string" && p.includes("T"),
      );
      expect(iso).toBeTruthy();
    });

    it("treats days 0 as all time", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ days: 0 });

      expect(
        sqlParamValues(dbHolder.current.calls.where[0]).some(
          (p: any) => typeof p === "string" && p.includes("T"),
        ),
      ).toBe(false);
    });

    it("clamps a negative days window to all time", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs({ days: -30 });

      expect(
        sqlParamValues(dbHolder.current.calls.where[0]).some(
          (p: any) => typeof p === "string" && p.includes("T"),
        ),
      ).toBe(false);
    });

    it("caps the days window at 365", async () => {
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });
      const before = Date.now() - 366 * 86_400_000;

      await getEmailLogs({ days: 10_000 });

      const iso = sqlParamValues(dbHolder.current.calls.where[0]).find(
        (p: any) => typeof p === "string" && p.includes("T"),
      );
      expect(new Date(iso as string).getTime()).toBeGreaterThan(before);
    });

    it("keeps the status chips showing what else is there", async () => {
      // The tallies honour every filter EXCEPT status and search, so selecting
      // "failed" doesn't collapse the other chips to zero.
      dbHolder.current = makeDbMock({
        selectQueue: logQueues([], 2, [40, 2, 0]),
      });

      const result = await getEmailLogs({ status: "failed", q: "shopper" });

      expect(result.counts.sent).toBe(40);
      expect(result.counts.skipped).toBe(0);
    });

    it("returns a friendly error instead of throwing when the query fails", async () => {
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = vi.fn(() => {
        throw new Error("connection reset");
      });

      const result = await getEmailLogs();

      expect(result.error).toBe("Could not load email logs.");
      expect(result.rows).toEqual([]);
      expect(result.counts).toEqual({});
      expect(logError).toHaveBeenCalledWith(
        "getEmailLogs failed",
        expect.anything(),
      );
    });

    it("reads the forwarded host in preference to host", async () => {
      // Behind the load balancer the real host arrives forwarded; reading only
      // `host` would scope every console to the proxy's own hostname.
      headerHolder.forwardedHost = "storemink.com";
      headerHolder.host = "acme.storemink.com";
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs();

      expect(getCurrentStoreId).not.toHaveBeenCalled();
    });

    it("falls back to platform scope when no host header is present at all", async () => {
      // parseHost("") is platform, so a header-less request sees store_id IS
      // NULL — it shows nothing rather than defaulting into some store's mail.
      headerHolder.host = null;
      headerHolder.forwardedHost = null;
      dbHolder.current = makeDbMock({ selectQueue: logQueues([], 0) });

      await getEmailLogs();

      expect(getCurrentStoreId).not.toHaveBeenCalled();
    });
  });

  describe("getEmailLog", () => {
    it("refuses an anonymous caller", async () => {
      vi.mocked(getViewerAccess).mockResolvedValue(null as any);

      expect((await getEmailLog("log-1")).error).toMatch(/not signed in/i);
    });

    it("refuses a viewer without activity.view", async () => {
      allow(false);

      expect((await getEmailLog("log-1")).error).toMatch(
        /don't have access to activity logs/i,
      );
    });

    it("returns the log with its rendered body", async () => {
      const detail = { ...LOG, bodyHtml: "<p>hi</p>", providerMessageId: "m1" };
      dbHolder.current = makeDbMock({ selectQueue: [[detail]] });

      const result = await getEmailLog("log-1");

      expect(result.log).toEqual(detail);
      expect(result.error).toBeUndefined();
    });

    it("returns a null body for a sensitive mailer rather than failing", async () => {
      // An OTP or invite carries a live credential, so send.ts never stores the
      // body. The UI says so instead of showing an empty frame.
      const detail = {
        ...LOG,
        mailer: "password_reset",
        bodyHtml: null,
        providerMessageId: "m1",
      };
      dbHolder.current = makeDbMock({ selectQueue: [[detail]] });

      const result = await getEmailLog("log-1");

      expect(result.log?.bodyHtml).toBeNull();
      expect(result.error).toBeUndefined();
    });

    it("keys the lookup on the id AND the store scope", async () => {
      // email_logs is service-role only (RLS on, no policies), so the store
      // filter IS the tenancy boundary here — it must never be dropped.
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      await getEmailLog("log-1");

      const params = sqlParamValues(dbHolder.current.calls.where[0]);
      expect(params).toContain("log-1");
      expect(params).toContain("store-1");
    });

    it("reports a miss as gone rather than leaking that it exists elsewhere", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const result = await getEmailLog("someone-elses-log");

      expect(result.error).toMatch(/no longer exists/i);
      expect(result.log).toBeUndefined();
    });

    it("scopes to platform rows on the platform host", async () => {
      headerHolder.host = "storemink.com";
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      await getEmailLog("log-1");

      expect(getCurrentStoreId).not.toHaveBeenCalled();
    });

    it("returns a friendly error instead of throwing when the read fails", async () => {
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = vi.fn(() => {
        throw new Error("connection reset");
      });

      const result = await getEmailLog("log-1");

      expect(result.error).toBe("Could not load that email.");
      expect(logError).toHaveBeenCalledWith(
        "getEmailLog failed",
        expect.anything(),
        { id: "log-1" },
      );
    });
  });
});
