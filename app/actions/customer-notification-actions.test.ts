/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  requireStorefrontStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const withUserSpy = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((identity: any, fn: any) => {
    withUserSpy.calls.push(identity);
    return Promise.resolve(fn(dbHolder.current.db));
  }),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  getMyCustomerNotifications,
  getMyCustomerUnreadCount,
  markMyCustomerNotificationRead,
  markAllMyCustomerNotificationsRead,
} from "./customer-notification-actions";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";
import { notifications } from "@/drizzle/schema";

const USER = { id: "cust-1", email: "shopper@example.com" } as any;

const ROW = {
  id: "n1",
  type: "order.placed",
  title: "Thanks for your order",
  body: "ORD10011027",
  url: "/orders/1",
  severity: "info",
  read_at: null,
  created_at: "2026-08-01T00:00:00Z",
};

// The shopper's own notification centre (§22). Scope is DOUBLE-LOCKED: withUser
// puts the RLS policy underneath, and every query also filters by the HOST
// store — one person shopping at two StoreMink stores must not see store A's
// notifications while browsing store B.
describe("customer-notification-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withUserSpy.calls = [];
    dbHolder.current = makeDbMock();
    vi.mocked(getServerUser).mockResolvedValue(USER);
    vi.mocked(requireStorefrontStoreId).mockResolvedValue("store-1");
  });

  describe("getMyCustomerNotifications", () => {
    it("returns an empty inbox for an anonymous visitor without touching the DB", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);

      const result = await getMyCustomerNotifications();

      expect(result).toEqual({ notifications: [], unread: 0 });
      expect(requireStorefrontStoreId).not.toHaveBeenCalled();
      expect(withUserSpy.calls).toHaveLength(0);
    });

    it("returns the rows and the unread count", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[ROW], [{ n: 3 }]] });

      const result = await getMyCustomerNotifications();

      expect(result.notifications).toEqual([ROW]);
      expect(result.unread).toBe(3);
      expect(result.error).toBeUndefined();
    });

    it("opens the user scope with the FULL identity (uid + email)", async () => {
      // Convention #2: a uid-only scope leaves the app.current_user_email GUC
      // unset, and the RLS helpers match platform operators by email.
      dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

      await getMyCustomerNotifications();

      expect(withUserSpy.calls[0]).toEqual({
        uid: "cust-1",
        email: "shopper@example.com",
      });
    });

    it("passes a null email rather than omitting the field", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "cust-2",
        email: null,
      } as any);
      dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

      await getMyCustomerNotifications();

      expect(withUserSpy.calls[0]).toEqual({ uid: "cust-2", email: null });
    });

    it("scopes the query to the recipient, the customer type and the host store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

      await getMyCustomerNotifications();

      const params = sqlParamValues(dbHolder.current.calls.where[0]);
      expect(params).toContain("cust-1");
      expect(params).toContain("customer");
      expect(params).toContain("store-1");
    });

    it("reports zero unread when the count query returns no row", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[ROW], []] });

      const result = await getMyCustomerNotifications();

      expect(result.unread).toBe(0);
    });

    it("clamps the page size up to 1", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

      await getMyCustomerNotifications(0);

      expect(dbHolder.current.calls.limit[0]).toBe(1);
    });

    it("clamps a negative page size up to 1", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

      await getMyCustomerNotifications(-25);

      expect(dbHolder.current.calls.limit[0]).toBe(1);
    });

    it("caps the page size at 50 however large the caller asks for", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

      await getMyCustomerNotifications(9999);

      expect(dbHolder.current.calls.limit[0]).toBe(50);
    });

    it("defaults to a 30-row page", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

      await getMyCustomerNotifications();

      expect(dbHolder.current.calls.limit[0]).toBe(30);
    });

    it("returns a friendly error instead of throwing when the read fails", async () => {
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = vi.fn(() => {
        throw new Error("connection reset");
      });

      const result = await getMyCustomerNotifications();

      expect(result).toEqual({
        notifications: [],
        unread: 0,
        error: "Couldn't load your notifications.",
      });
      expect(logError).toHaveBeenCalledWith(
        "customer notifications: list failed",
        expect.anything(),
      );
    });
  });

  describe("getMyCustomerUnreadCount", () => {
    it("returns 0 for an anonymous visitor", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);

      expect(await getMyCustomerUnreadCount()).toBe(0);
      expect(withUserSpy.calls).toHaveLength(0);
    });

    it("returns the count the bell polls for", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ n: 7 }]] });

      expect(await getMyCustomerUnreadCount()).toBe(7);
    });

    it("returns 0 when the count query yields no row", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      expect(await getMyCustomerUnreadCount()).toBe(0);
    });

    it("excludes archived and already-read rows, and scopes to the host store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ n: 1 }]] });

      await getMyCustomerUnreadCount();

      const params = sqlParamValues(dbHolder.current.calls.where[0]);
      expect(params).toContain("cust-1");
      expect(params).toContain("customer");
      expect(params).toContain("store-1");
    });

    it("passes a null email rather than omitting the field", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "cust-2",
        email: null,
      } as any);
      dbHolder.current = makeDbMock({ selectQueue: [[{ n: 0 }]] });

      await getMyCustomerUnreadCount();

      expect(withUserSpy.calls[0]).toEqual({ uid: "cust-2", email: null });
    });

    it("returns 0 rather than throwing when the store cannot be resolved", async () => {
      // A badge is decoration; it must never be able to break the page it
      // renders on.
      vi.mocked(requireStorefrontStoreId).mockRejectedValue(
        new Error("unknown host"),
      );

      expect(await getMyCustomerUnreadCount()).toBe(0);
      expect(logError).toHaveBeenCalledWith(
        "customer notifications: unread count failed",
        expect.anything(),
      );
    });
  });

  describe("markMyCustomerNotificationRead", () => {
    it("refuses when nobody is signed in", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);

      const result = await markMyCustomerNotificationRead("n1");

      expect(result.error).toMatch(/not signed in/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("refuses an empty id", async () => {
      const result = await markMyCustomerNotificationRead("");

      expect(result.error).toMatch(/missing notification/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("marks the row read", async () => {
      const result = await markMyCustomerNotificationRead("n1");

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.update[0]).toBe(notifications);
      expect(dbHolder.current.calls.set[0]).toHaveProperty("readAt");
    });

    it("keys the update on the id AND the caller's own recipient row", async () => {
      // Without the recipient predicate, any signed-in shopper could mark
      // somebody else's notification read by guessing an id.
      await markMyCustomerNotificationRead("n1");

      const params = sqlParamValues(dbHolder.current.calls.where[0]);
      expect(params).toContain("n1");
      expect(params).toContain("cust-1");
      expect(params).toContain("customer");
    });

    it("passes a null email rather than omitting the field", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "cust-2",
        email: null,
      } as any);

      await markMyCustomerNotificationRead("n1");

      expect(withUserSpy.calls[0]).toEqual({ uid: "cust-2", email: null });
    });

    it("returns a friendly error when the write fails", async () => {
      dbHolder.current = makeDbMock({ failUpdateFor: [notifications] });

      const result = await markMyCustomerNotificationRead("n1");

      expect(result.error).toMatch(/couldn't update that notification/i);
      expect(logError).toHaveBeenCalledWith(
        "customer notifications: mark read failed",
        expect.anything(),
      );
    });
  });

  describe("markAllMyCustomerNotificationsRead", () => {
    it("refuses when nobody is signed in", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);

      const result = await markAllMyCustomerNotificationsRead();

      expect(result.error).toMatch(/not signed in/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("marks this store's unread rows read", async () => {
      const result = await markAllMyCustomerNotificationsRead();

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toHaveProperty("readAt");
    });

    it("does NOT clear notifications from the shopper's other stores", async () => {
      // The whole point of the host-store lock: "mark all read" on store B must
      // leave store A's inbox alone.
      await markAllMyCustomerNotificationsRead();

      const params = sqlParamValues(dbHolder.current.calls.where[0]);
      expect(params).toContain("store-1");
      expect(params).toContain("cust-1");
      expect(params).toContain("customer");
    });

    it("passes a null email rather than omitting the field", async () => {
      vi.mocked(getServerUser).mockResolvedValue({
        id: "cust-2",
        email: null,
      } as any);

      await markAllMyCustomerNotificationsRead();

      expect(withUserSpy.calls[0]).toEqual({ uid: "cust-2", email: null });
    });

    it("returns a friendly error when the store cannot be resolved", async () => {
      vi.mocked(requireStorefrontStoreId).mockRejectedValue(
        new Error("unknown host"),
      );

      const result = await markAllMyCustomerNotificationsRead();

      expect(result.error).toMatch(/couldn't update your notifications/i);
      expect(logError).toHaveBeenCalledWith(
        "customer notifications: mark all read failed",
        expect.anything(),
      );
    });

    it("returns a friendly error when the write fails", async () => {
      dbHolder.current = makeDbMock({ failUpdateFor: [notifications] });

      const result = await markAllMyCustomerNotificationsRead();

      expect(result.error).toMatch(/couldn't update your notifications/i);
    });
  });
});
