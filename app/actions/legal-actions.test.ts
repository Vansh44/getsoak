/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/legal/store", () => ({
  recordSignupConsent: vi.fn(async () => {}),
  getSignupDocs: vi.fn(async () => []),
  outstandingDocs: vi.fn(async () => []),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  acceptPlatformPolicies,
  acceptUpdatedPolicies,
  getConsentDocuments,
} from "./legal-actions";
import { getServerUser } from "@/lib/auth/server-user";
import { logError } from "@/lib/observability/logger";
import {
  recordSignupConsent,
  getSignupDocs,
  outstandingDocs,
} from "@/lib/legal/store";
import { admins } from "@/drizzle/schema";

const USER = { id: "uid-1", email: "owner@example.com" } as any;

// legal-actions.ts is the consent WRITE path (§25). The client ticks a box;
// these decide what that means — the server re-reads the documents in force and
// the client never says which version it agreed to.
describe("legal-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(getServerUser).mockResolvedValue(USER);
    vi.mocked(outstandingDocs).mockResolvedValue([]);
    vi.mocked(getSignupDocs).mockResolvedValue([]);
  });

  describe("acceptPlatformPolicies", () => {
    it("refuses when nobody is signed in", async () => {
      // A real failure, not something to swallow: it means the caller ran
      // before the session cookie existed.
      vi.mocked(getServerUser).mockResolvedValue(null);

      const result = await acceptPlatformPolicies({});

      expect(result.error).toMatch(/not signed in/i);
      expect(recordSignupConsent).not.toHaveBeenCalled();
    });

    it("records consent against the session's own identity", async () => {
      const result = await acceptPlatformPolicies({});

      expect(result.success).toBe(true);
      expect(recordSignupConsent).toHaveBeenCalledWith({
        userId: "uid-1",
        email: "owner@example.com",
        actorType: "merchant",
        context: "signup",
      });
    });

    it("passes a null email through rather than inventing one", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "uid-2",
        email: null,
      } as any);

      await acceptPlatformPolicies({});

      expect(recordSignupConsent).toHaveBeenCalledWith(
        expect.objectContaining({ email: null }),
      );
    });

    it("leaves marketing_opt_in alone when the optional box is unticked", async () => {
      await acceptPlatformPolicies({});

      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("treats an absent marketingOptIn the same as false", async () => {
      await acceptPlatformPolicies({ marketingOptIn: false });

      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("writes the marketing preference to its own column when ticked", async () => {
      // Separate write to a separate column, deliberately: agreeing to the
      // Terms is a contract, wanting product email is a preference, and
      // conflating them is what makes a consent record arguable later.
      const result = await acceptPlatformPolicies({ marketingOptIn: true });

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.update[0]).toBe(admins);
      expect(dbHolder.current.calls.set[0]).toEqual({ marketingOptIn: true });
      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "uid-1",
      );
    });

    it("still succeeds when the marketing write fails", async () => {
      // Never fail signup over a mailing preference.
      dbHolder.current = makeDbMock({ failUpdateFor: [admins] });

      const result = await acceptPlatformPolicies({ marketingOptIn: true });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        "legal: marketing opt-in write failed",
        expect.anything(),
        { userId: "uid-1" },
      );
    });

    it("records the consent before touching the preference column", async () => {
      // Consent is the load-bearing write; a preference failure must not be
      // able to prevent it.
      const order: string[] = [];
      vi.mocked(recordSignupConsent).mockImplementation(async () => {
        order.push("consent");
      });
      dbHolder.current = makeDbMock();
      const realUpdate = dbHolder.current.db.update;
      dbHolder.current.db.update = vi.fn((t: any) => {
        order.push("preference");
        return realUpdate(t);
      });

      await acceptPlatformPolicies({ marketingOptIn: true });

      expect(order).toEqual(["consent", "preference"]);
    });
  });

  describe("acceptUpdatedPolicies", () => {
    it("refuses when nobody is signed in", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);

      const result = await acceptUpdatedPolicies();

      expect(result.error).toMatch(/not signed in/i);
      expect(recordSignupConsent).not.toHaveBeenCalled();
    });

    it("succeeds without writing when nothing is outstanding", async () => {
      // A double submit or a stale tab. Not an error — the caller just wants to
      // know it can move on.
      vi.mocked(outstandingDocs).mockResolvedValue([]);

      const result = await acceptUpdatedPolicies();

      expect(result.success).toBe(true);
      expect(recordSignupConsent).not.toHaveBeenCalled();
    });

    it("re-derives what is outstanding instead of trusting the caller", async () => {
      // This is a server action, reachable directly — the gate having sent them
      // here is not evidence that anything is actually outstanding.
      vi.mocked(outstandingDocs)
        .mockResolvedValueOnce([{ kind: "terms" } as any])
        .mockResolvedValueOnce([]);

      await acceptUpdatedPolicies();

      expect(outstandingDocs).toHaveBeenCalledWith("uid-1");
    });

    it("records the acceptance under the reaccept context", async () => {
      // So a report can tell "agreed when they joined" from "agreed when v2
      // came out".
      vi.mocked(outstandingDocs)
        .mockResolvedValueOnce([{ kind: "terms" } as any])
        .mockResolvedValueOnce([]);

      const result = await acceptUpdatedPolicies();

      expect(result.success).toBe(true);
      expect(recordSignupConsent).toHaveBeenCalledWith({
        userId: "uid-1",
        email: "owner@example.com",
        actorType: "merchant",
        context: "reaccept",
      });
    });

    it("verifies the write stuck and reports failure when it did not", async () => {
      // recordSignupConsent swallows its errors by design, so without this
      // re-check a failure would bounce the merchant back to the gate with no
      // explanation.
      vi.mocked(outstandingDocs)
        .mockResolvedValueOnce([{ kind: "terms" } as any])
        .mockResolvedValueOnce([{ kind: "terms" } as any]);

      const result = await acceptUpdatedPolicies();

      expect(result.error).toMatch(/couldn't record that/i);
      expect(result.success).toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        "legal: re-acceptance did not stick",
        null,
        { userId: "uid-1" },
      );
    });

    it("passes a null email through rather than inventing one", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "uid-3",
        email: null,
      } as any);
      vi.mocked(outstandingDocs)
        .mockResolvedValueOnce([{ kind: "aup" } as any])
        .mockResolvedValueOnce([]);

      await acceptUpdatedPolicies();

      expect(recordSignupConsent).toHaveBeenCalledWith(
        expect.objectContaining({ email: null }),
      );
    });
  });

  describe("getConsentDocuments", () => {
    it("returns an empty list when nothing is published", async () => {
      vi.mocked(getSignupDocs).mockResolvedValue([]);

      expect(await getConsentDocuments()).toEqual([]);
    });

    it("returns only what the consent sentence needs to name each document", async () => {
      // Titles, slugs and versions — never the bodies. The wizard has no use
      // for them and they are large.
      vi.mocked(getSignupDocs).mockResolvedValue([
        {
          kind: "terms",
          title: "Terms of Service",
          version: 2,
          body: "<p>long</p>",
          checksum: "abc",
          id: "doc-1",
        } as any,
        {
          kind: "privacy",
          title: "Privacy Policy",
          version: 1,
          body: "<p>long</p>",
          checksum: "def",
          id: "doc-2",
        } as any,
      ]);

      const docs = await getConsentDocuments();

      expect(docs).toEqual([
        { kind: "terms", title: "Terms of Service", version: 2 },
        { kind: "privacy", title: "Privacy Policy", version: 1 },
      ]);
      expect(docs[0]).not.toHaveProperty("body");
    });

    it("is public — it runs before anyone has an account", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      vi.mocked(getSignupDocs).mockResolvedValue([
        { kind: "terms", title: "Terms", version: 1 } as any,
      ]);

      const docs = await getConsentDocuments();

      expect(docs).toHaveLength(1);
      expect(getServerUser).not.toHaveBeenCalled();
    });
  });
});
