/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const headerHolder = vi.hoisted(() => ({
  host: "acme.storemink.com" as string | null,
  forwardedHost: null as string | null,
}));
const dbHolder = vi.hoisted(() => ({ current: null as any }));
const withUserSpy = vi.hoisted(() => ({ identities: [] as any[] }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) =>
      key === "x-forwarded-host"
        ? headerHolder.forwardedHost
        : headerHolder.host,
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({
  after: vi.fn((callback: () => void) => callback()),
}));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((identity: any, fn: any) => {
    withUserSpy.identities.push(identity);
    return Promise.resolve(fn(dbHolder.current.db));
  }),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerAccess: vi.fn(),
  getViewerContext: vi.fn(),
}));
vi.mock("@/lib/pos/locations", () => ({ getStoreLocations: vi.fn() }));
vi.mock("@/lib/notifications/config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notifications/config")>();
  return {
    ...actual,
    resolveAllNotifications: vi.fn(),
    resolveNotification: vi.fn(),
  };
});
vi.mock("@/lib/store/brand", () => ({ getStoreBrandById: vi.fn() }));
vi.mock("@/lib/email/notification-emails", () => ({
  platformBrand: vi.fn(() => ({
    name: "StoreMink",
    domain: "storemink.com",
    fromEmail: "hello@storemink.com",
  })),
  renderNotificationEmail: vi.fn(({ item }: any) => ({
    html: `<p>${item.body}</p>`,
    subject: item.title,
  })),
}));
vi.mock("@/lib/email/sender", () => ({
  fromAddress: vi.fn(() => "Acme <notifications@storemink.com>"),
}));
vi.mock("@/lib/email/suppression", () => ({
  findSuppressed: vi.fn(async () => new Set<string>()),
  normalizeEmail: vi.fn((email: string) => email.trim().toLowerCase()),
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
}));
vi.mock("@/lib/email/trigger-worker", () => ({
  triggerEmailWorker: vi.fn(async () => {}),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { getViewerAccess, getViewerContext } from "@/app/dashboard/lib/access";
import { getStoreLocations } from "@/lib/pos/locations";
import {
  resolveAllNotifications,
  resolveNotification,
} from "@/lib/notifications/config";
import { getStoreBrandById } from "@/lib/store/brand";
import {
  platformBrand,
  renderNotificationEmail,
} from "@/lib/email/notification-emails";
import { findSuppressed } from "@/lib/email/suppression";
import { sendEmail } from "@/lib/email/send";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
import {
  activityEvents,
  admins,
  notificationEmailQueue,
  notificationPreferences,
  notificationSettings,
} from "@/drizzle/schema";
import {
  archiveNotification,
  getActivityFeed,
  getDeliveryHealth,
  getMyNotificationPreferences,
  getMyNotifications,
  getNotificationConsole,
  getNotificationDetail,
  getStoreNotificationAudience,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  previewNotificationEmail,
  retryFailedEmail,
  saveMyNotificationPreferences,
  saveNotificationConfig,
  sendTestNotificationEmail,
} from "./notification-actions";

const USER = { id: "admin-1", email: "Owner@Acme.test" } as any;
const CONTEXT = {
  userId: "admin-1",
  userEmail: "Owner@Acme.test",
  profile: { id: "admin-1" },
} as any;

const NOTIFICATION = {
  id: "notification-1",
  type: "order.placed",
  title: "New order",
  body: "Order ORD1001",
  url: "/dashboard/orders/order-1",
  severity: "success",
  read_at: null,
  created_at: "2026-08-14T00:00:00.000Z",
};

const RESOLVED = {
  key: "order.placed",
  displayName: "New order",
  description: "A shopper completed checkout.",
  category: "Orders",
  group: "Orders",
  section: "orders",
  severity: "success",
  audiences: {
    team: {
      channels: {
        email: true,
        web: true,
        sms: false,
        push: false,
        whatsapp: false,
      },
      templates: {},
      routing: { mode: "permission", scope: "store", roles: [], admins: [] },
    },
    customer: {
      channels: {
        email: true,
        web: true,
        sms: false,
        push: false,
        whatsapp: false,
      },
      templates: {},
    },
  },
  digest: "instant",
  isEnabled: true,
  isCustom: false,
  configurable: true,
  hasLocation: true,
  isConfigured: false,
  storeName: "Acme",
} as any;

function allow(overrides: Record<string, unknown> = {}) {
  vi.mocked(getViewerAccess).mockResolvedValue({
    userId: "admin-1",
    email: "owner@acme.test",
    isSuperadmin: true,
    can: vi.fn(() => true),
    ...overrides,
  } as any);
}

function deny() {
  allow({ can: vi.fn(() => false) });
}

beforeEach(() => {
  vi.clearAllMocks();
  headerHolder.host = "acme.storemink.com";
  headerHolder.forwardedHost = null;
  withUserSpy.identities = [];
  dbHolder.current = makeDbMock();
  vi.mocked(getServerUser).mockResolvedValue(USER);
  vi.mocked(getCurrentStoreId).mockResolvedValue("store-1");
  vi.mocked(getViewerContext).mockResolvedValue(CONTEXT);
  vi.mocked(getStoreLocations).mockResolvedValue([] as any);
  vi.mocked(resolveAllNotifications).mockResolvedValue([RESOLVED]);
  vi.mocked(resolveNotification).mockResolvedValue(RESOLVED);
  vi.mocked(getStoreBrandById).mockResolvedValue({
    name: "Acme",
    domain: "acme.storemink.com",
    fromEmail: "hello@acme.test",
  } as any);
  vi.mocked(findSuppressed).mockResolvedValue(new Set());
  vi.mocked(sendEmail).mockResolvedValue({ sent: true } as any);
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
  allow();
});

describe("notification inbox actions", () => {
  it("returns an empty inbox for an anonymous viewer without resolving scope", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);

    expect(await getMyNotifications()).toEqual({
      notifications: [],
      unread: 0,
    });
    expect(getCurrentStoreId).not.toHaveBeenCalled();
    expect(withUserSpy.identities).toHaveLength(0);
  });

  it("reads the inbox and count under the viewer's full identity", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[NOTIFICATION], [{ n: 4 }]],
    });

    const result = await getMyNotifications();

    expect(result).toEqual({ notifications: [NOTIFICATION], unread: 4 });
    expect(withUserSpy.identities[0]).toEqual({
      uid: "admin-1",
      email: "Owner@Acme.test",
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["admin-1", "owner@acme.test", "store-1"]),
    );
  });

  it("prefers x-forwarded-host and keeps platform reads out of a store scope", async () => {
    headerHolder.host = "acme.storemink.com";
    headerHolder.forwardedHost = "storemink.com";
    dbHolder.current = makeDbMock({ selectQueue: [[], [{ n: 0 }]] });

    await getMyNotifications();

    expect(getCurrentStoreId).not.toHaveBeenCalled();
    expect(sqlParamValues(dbHolder.current.calls.where[0])).not.toContain(
      "store-1",
    );
  });

  it("clamps the inbox size to the safe 1..50 range", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[], [], [], []] });
    await getMyNotifications(0);
    await getMyNotifications(5_000);

    expect(dbHolder.current.calls.limit).toEqual([1, 50]);
  });

  it("contains database errors so the bell cannot take down the page", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("database unavailable");
    });

    expect(await getMyNotifications()).toEqual({
      notifications: [],
      unread: 0,
      error: "Couldn't load notifications.",
    });
    expect(logError).toHaveBeenCalledWith(
      "notifications: inbox read failed",
      expect.any(Error),
    );
  });

  it("returns the unread count and degrades to zero on failure", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ n: 7 }]] });
    expect(await getUnreadNotificationCount()).toBe(7);

    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("offline");
    });
    expect(await getUnreadNotificationCount()).toBe(0);
  });

  it("marks only the caller's unread notification as read", async () => {
    expect(await markNotificationRead("notification-1")).toEqual({
      success: true,
    });
    expect(dbHolder.current.calls.set[0]).toHaveProperty("readAt");
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["notification-1", "admin-1", "owner@acme.test"]),
    );
  });

  it("rejects anonymous and malformed mark-read requests", async () => {
    expect(await markNotificationRead("")).toEqual({
      error: "Missing notification.",
    });
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect(await markNotificationRead("notification-1")).toEqual({
      error: "Not signed in.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("marks all unread notifications only inside the current host scope", async () => {
    expect(await markAllNotificationsRead()).toEqual({ success: true });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["admin-1", "owner@acme.test", "store-1"]),
    );
  });

  it("archives only a notification belonging to the caller", async () => {
    expect(await archiveNotification("notification-1")).toEqual({
      success: true,
    });
    expect(dbHolder.current.calls.set[0]).toHaveProperty("archivedAt");
    expect(dbHolder.current.calls.set[0]).toHaveProperty("readAt");
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["notification-1", "admin-1", "owner@acme.test"]),
    );
  });
});

describe("activity feed", () => {
  it("requires a signed-in viewer", async () => {
    vi.mocked(getViewerContext).mockResolvedValue(null);
    expect(await getActivityFeed()).toEqual({
      events: [],
      total: 0,
      error: "Not signed in.",
    });
  });

  it("returns scoped, paginated activity with null payloads normalized", async () => {
    const row = {
      id: "activity-1",
      type: "order.placed",
      actor_type: "admin",
      actor_label: "Owner",
      subject_type: "order",
      subject_label: "ORD1001",
      payload: null,
      created_at: "2026-08-14T00:00:00.000Z",
    };
    dbHolder.current = makeDbMock({ selectQueue: [[row], [{ n: 51 }]] });

    const result = await getActivityFeed({ page: 2, pageSize: 500 });

    expect(result.events[0].payload).toEqual({});
    expect(result.total).toBe(51);
    expect(dbHolder.current.calls.limit[0]).toBe(100);
    expect(dbHolder.current.calls.offset[0]).toBe(100);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "store-1",
    );
  });

  it("applies a valid event type and ignores an unknown one", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[], [], [], []] });
    await getActivityFeed({ type: "order.placed" });
    await getActivityFeed({ type: "made.up.event" });

    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "order.placed",
    );
    expect(sqlParamValues(dbHolder.current.calls.where[2])).not.toContain(
      "made.up.event",
    );
  });

  it("expands a known event group and applies a date floor", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    await getActivityFeed({ group: "Orders", dateRange: "7d" });

    const params = sqlParamValues(dbHolder.current.calls.where[0]);
    expect(params).toContain("order.placed");
    expect(
      params.some((value) => typeof value === "string" && value.includes("T")),
    ).toBe(true);
  });

  it("contains database failures and records the affected scope", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("read failed");
    });

    expect(await getActivityFeed()).toEqual({
      events: [],
      total: 0,
      error: "Couldn't load the activity feed.",
    });
    expect(logError).toHaveBeenCalledWith(
      "notifications: activity feed failed",
      expect.any(Error),
      { storeId: "store-1" },
    );
  });
});

describe("notification console and detail", () => {
  it("enforces view access before resolving configuration", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue(null);
    expect((await getNotificationConsole()).error).toBe("Not signed in.");

    deny();
    expect((await getNotificationConsole()).error).toMatch(
      /don't have access/i,
    );
    expect(resolveAllNotifications).not.toHaveBeenCalled();
  });

  it("builds catalog counts independently of list filters", async () => {
    const result = await getNotificationConsole({
      category: "Orders",
      audience: "team",
      channel: "email",
      q: "checkout",
    });

    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.counts).toMatchObject({
      all: 1,
      Orders: 1,
      "audience:team": 1,
      "audience:customer": 1,
      "channel:email": 1,
      "channel:web": 1,
    });
    expect(result.canManage).toBe(true);
  });

  it("returns an empty filtered list without changing catalog totals", async () => {
    const result = await getNotificationConsole({ q: "no such event" });
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.counts.all).toBe(1);
  });

  it("loads one detail with defaults, variables, locations and audience", async () => {
    vi.mocked(getStoreLocations).mockResolvedValue([
      { id: "location-1" },
      { id: "location-2" },
    ] as any);
    dbHolder.current = makeDbMock({ selectQueue: [[], []] });

    const result = await getNotificationDetail("order.placed");

    expect("notification" in result && result.notification.key).toBe(
      "order.placed",
    );
    expect("multiLocation" in result && result.multiLocation).toBe(true);
    expect("defaults" in result && result.defaults.team.subject).toBeTruthy();
    expect(
      "defaults" in result && result.defaults.customer.subject,
    ).toBeTruthy();
    expect("variables" in result && result.variables.length).toBeGreaterThan(0);
  });

  it("rejects unknown details without touching configuration storage", async () => {
    expect(await getNotificationDetail("not.real")).toEqual({
      error: "Unknown notification.",
    });
    expect(resolveNotification).not.toHaveBeenCalled();
  });
});

describe("saving notification configuration", () => {
  it("requires manage access, a known event and a store scope", async () => {
    deny();
    expect((await saveNotificationConfig("order.placed", {})).error).toMatch(
      /don't have permission/i,
    );

    allow();
    expect((await saveNotificationConfig("not.real", {})).error).toMatch(
      /unknown notification/i,
    );

    headerHolder.host = "storemink.com";
    expect((await saveNotificationConfig("order.placed", {})).error).toMatch(
      /need a store/i,
    );
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects invalid digests and unavailable channels", async () => {
    expect(
      (await saveNotificationConfig("order.placed", { digest: "weekly" }))
        .error,
    ).toMatch(/invalid email frequency/i);

    expect(
      (
        await saveNotificationConfig("order.placed", {
          audiences: { team: { channels: { sms: true } } },
        })
      ).error,
    ).toMatch(/isn't connected yet/i);
  });

  it("does not allow a mandatory security notification to be switched off", async () => {
    expect(
      (
        await saveNotificationConfig("admin.role_changed", {
          isEnabled: false,
        })
      ).error,
    ).toMatch(/can't be switched off/i);
  });

  it("keeps customer delivery separate from team recipient routing", async () => {
    expect(
      (
        await saveNotificationConfig("order.placed", {
          audiences: {
            customer: { routing: { mode: "all" } },
          },
        })
      ).error,
    ).toMatch(/always go to the customer/i);
  });

  it("allows only owners to narrow team recipients", async () => {
    allow({ isSuperadmin: false });
    expect(
      (
        await saveNotificationConfig("order.placed", {
          audiences: { team: { routing: { mode: "all" } } },
        })
      ).error,
    ).toMatch(/only a store owner/i);
  });

  it("validates template variables and copy addresses", async () => {
    const badVariable = await saveNotificationConfig("order.placed", {
      audiences: {
        team: { templates: { email: { subject: "{{not_a_variable}}" } } },
      },
    });
    expect(badVariable.error).toBeTruthy();

    const badCc = await saveNotificationConfig("order.placed", {
      audiences: {
        team: { templates: { email: { cc: "ok@example.com, bad\nheader" } } },
      },
    });
    expect(badCc.error).toContain("isn't a valid email address");
  });

  it("does not accept cc or bcc fields for customer messages", async () => {
    await saveNotificationConfig("order.placed", {
      audiences: {
        customer: {
          templates: {
            email: {
              subject: "Order received",
              cc: "staff@acme.test",
              bcc: "owner@acme.test",
            },
          },
        },
      },
    });

    const saved = dbHolder.current.calls.values[0];
    expect(saved.templates.customer.email).toEqual({
      subject: "Order received",
    });
  });

  it("updates an existing store row with normalized configuration", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "settings-1" }]],
    });

    const result = await saveNotificationConfig("order.placed", {
      digest: "daily",
      isEnabled: true,
      audiences: {
        team: {
          channels: { email: true, web: false },
          routing: {
            mode: "admins",
            scope: "event_location",
            admins: ["admin-2"],
          },
          templates: {
            email: {
              subject: "New order {{subject_label}}",
              cc: "OPS@ACME.TEST; ops@acme.test",
            },
          },
        },
      },
    });

    expect(result).toEqual({ success: true });
    expect(dbHolder.current.calls.update[0]).toBe(notificationSettings);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      digest: "daily",
      isEnabled: true,
      routing: "admins",
      routingScope: "event_location",
      targetAdmins: ["admin-2"],
      channels: { team: { email: true, web: false } },
    });
    expect(dbHolder.current.calls.set[0].templates.team.email.cc).toBe(
      "ops@acme.test",
    );
    expect(revalidatePath).toHaveBeenCalledTimes(2);
  });

  it("inserts a store-scoped row when no override exists", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(
      await saveNotificationConfig("order.placed", { digest: "hourly" }),
    ).toEqual({ success: true });
    expect(dbHolder.current.calls.insert[0]).toBe(notificationSettings);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      eventKey: "order.placed",
      digest: "hourly",
      updatedBy: "admin-1",
    });
  });
});

describe("email preview and test delivery", () => {
  it("renders a store-branded preview from sample values", async () => {
    const result = await previewNotificationEmail("order.placed", "team", {
      subject: "New order {{subject_label}}",
      body: "Total {{total}}",
    });

    expect(result.subject).toContain("ORD");
    expect(result.html).toContain("₹");
    expect(getStoreBrandById).toHaveBeenCalledWith("store-1");
    expect(renderNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://example.storemink.com" }),
    );
  });

  it("uses platform branding on the platform host", async () => {
    headerHolder.host = "storemink.com";
    await previewNotificationEmail("order.placed", "team", {});
    expect(platformBrand).toHaveBeenCalled();
    expect(getStoreBrandById).not.toHaveBeenCalled();
  });

  it("sends test mail only to the signed-in admin and labels it as a test", async () => {
    const result = await sendTestNotificationEmail("order.placed", "customer", {
      subject: "Order {{order_ref}}",
      body: "Thanks",
    });

    expect(result).toEqual({ success: true, sentTo: "owner@acme.test" });
    expect(renderNotificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        isTeam: false,
        item: expect.objectContaining({
          eventKey: "order.placed",
          url: "/orders/sample-order",
        }),
      }),
    );
    expect(rateLimit).toHaveBeenCalledWith("notif-test:admin-1", {
      max: 10,
      windowSeconds: 600,
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@acme.test",
        subject: expect.stringMatching(/^\[Test\] /),
        mailer: "notification_test",
      }),
    );
  });

  it("blocks test mail without an address or when rate limited", async () => {
    allow({ email: "" });
    expect(
      (await sendTestNotificationEmail("order.placed", "team", {})).error,
    ).toMatch(/no email address/i);

    allow();
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    expect(
      (await sendTestNotificationEmail("order.placed", "team", {})).error,
    ).toMatch(/too many test emails/i);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("surfaces provider refusal without claiming the email was sent", async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      sent: false,
      error: "provider unavailable",
    } as any);

    expect(await sendTestNotificationEmail("order.placed", "team", {})).toEqual(
      { error: "provider unavailable" },
    );
    expect(logError).toHaveBeenCalledWith(
      "notifications: test send failed",
      "provider unavailable",
      { key: "order.placed" },
    );
  });
});

describe("personal notification preferences", () => {
  it("requires a signed-in staff profile", async () => {
    vi.mocked(getViewerContext).mockResolvedValue({
      ...CONTEXT,
      profile: null,
    });
    expect(await getMyNotificationPreferences()).toEqual({
      rows: [],
      error: "Not signed in.",
    });
  });

  it("applies a person's override only to enabled team events", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            eventKey: "order.placed",
            inApp: false,
            email: true,
          },
        ],
      ],
    });

    const result = await getMyNotificationPreferences();

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      key: "order.placed",
      inApp: false,
      email: true,
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["user", "admin-1", "store-1"]),
    );
  });

  it("rejects empty, oversized and wholly invalid preference changes", async () => {
    expect(await saveMyNotificationPreferences([])).toEqual({
      error: "Nothing to save.",
    });
    expect(
      await saveMyNotificationPreferences(
        Array.from({ length: 201 }, () => ({
          eventKey: "order.placed",
          inApp: true,
          email: true,
        })),
      ),
    ).toEqual({ error: "Too many changes at once." });
    expect(
      await saveMyNotificationPreferences([
        { eventKey: "not.real", inApp: true, email: true },
        { eventKey: "admin.role_changed", inApp: false, email: false },
      ]),
    ).toEqual({ error: "No valid settings to save." });
  });

  it("updates existing preferences and inserts new ones under the current store", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ id: "preference-1" }], []],
    });

    const result = await saveMyNotificationPreferences([
      { eventKey: "order.placed", inApp: false, email: true },
      { eventKey: "inventory.low_stock", inApp: true, email: false },
    ]);

    expect(result).toEqual({ success: true });
    expect(dbHolder.current.calls.update[0]).toBe(notificationPreferences);
    expect(dbHolder.current.calls.insert[0]).toBe(notificationPreferences);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      scope: "user",
      recipientId: "admin-1",
      eventKey: "inventory.low_stock",
    });
    expect(revalidatePath).toHaveBeenCalledWith(
      "/dashboard/settings/notifications/me",
    );
  });
});

describe("notification audience", () => {
  it("returns no store audience on the platform host", async () => {
    headerHolder.host = "storemink.com";
    expect(await getStoreNotificationAudience()).toEqual({
      roles: [],
      members: [],
    });
  });

  it("excludes suspended staff and mirrors role permissions into sections", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "owner-1",
            email: "owner@acme.test",
            role: "superadmin",
            firstName: "Asha",
            lastName: "Shah",
          },
          {
            id: "staff-1",
            email: "ops@acme.test",
            role: "ops",
            firstName: null,
            lastName: null,
          },
        ],
        [
          {
            slug: "ops",
            name: "Operations",
            permissions: { orders: ["view"] },
          },
        ],
      ],
    });

    const result = await getStoreNotificationAudience();

    expect(result.roles).toEqual([
      { slug: "superadmin", name: "Owner" },
      { slug: "ops", name: "Operations" },
    ]);
    expect(result.members[0].name).toBe("Asha Shah");
    expect(result.members[0].sections.length).toBeGreaterThan(5);
    expect(result.members[1]).toMatchObject({
      name: "ops@acme.test",
      sections: ["orders"],
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "store-1",
    );
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });
});

describe("failed notification delivery", () => {
  const FAILURE = {
    id: "queue-1",
    email: "Bounced@Example.com",
    title: "New order",
    eventKey: "order.placed",
    error: "hard bounce",
    attempts: 4,
    createdAt: "2026-08-14T00:00:00.000Z",
  };

  it("enforces notification view access", async () => {
    deny();
    expect(await getDeliveryHealth()).toEqual({
      failures: [],
      total: 0,
      error: "You don't have access to notification settings.",
    });
  });

  it("reports recent store-scoped failures and suppression state", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[FAILURE], [{ n: 8 }]],
    });
    vi.mocked(findSuppressed).mockResolvedValue(
      new Set(["bounced@example.com"]),
    );

    const result = await getDeliveryHealth();

    expect(result).toEqual({
      failures: [{ ...FAILURE, suppressed: true }],
      total: 8,
    });
    expect(dbHolder.current.calls.limit[0]).toBe(20);
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["store-1", "failed"]),
    );
  });

  it("requires manage access before retrying a failed message", async () => {
    deny();
    expect(await retryFailedEmail("queue-1")).toEqual({
      error: "You don't have permission to manage notifications.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("refuses missing, stale and suppressed retry targets", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await retryFailedEmail("missing")).toEqual({
      error: "That message is no longer retryable.",
    });

    dbHolder.current = makeDbMock({ selectQueue: [[FAILURE]] });
    vi.mocked(findSuppressed).mockResolvedValue(
      new Set(["bounced@example.com"]),
    );
    expect((await retryFailedEmail("queue-1")).error).toMatch(
      /retrying can't succeed/i,
    );
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("atomically requeues a store-owned failed row and wakes the worker", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[FAILURE]],
      returning: [{ id: "queue-1" }],
    });

    expect(await retryFailedEmail("queue-1")).toEqual({ success: true });
    expect(dbHolder.current.calls.update[0]).toBe(notificationEmailQueue);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      claimedAt: null,
      lastError: null,
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["queue-1", "store-1", "failed"]),
    );
    expect(triggerEmailWorker).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith(
      "/dashboard/settings/notifications",
    );
  });
});

describe("schema targets remain explicit", () => {
  it("uses the expected tables for the highest-risk writes", async () => {
    await markNotificationRead("notification-1");
    expect(dbHolder.current.calls.update).toHaveLength(1);

    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "settings-1" }]] });
    await saveNotificationConfig("order.placed", { digest: "daily" });
    expect(dbHolder.current.calls.update[0]).toBe(notificationSettings);

    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "pref-1" }]] });
    await saveMyNotificationPreferences([
      { eventKey: "order.placed", inApp: true, email: false },
    ]);
    expect(dbHolder.current.calls.update[0]).toBe(notificationPreferences);

    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    await getActivityFeed();
    expect(dbHolder.current.calls.select).toHaveLength(2);
    expect(activityEvents).toBeTruthy();
    expect(admins).toBeTruthy();
  });
});
