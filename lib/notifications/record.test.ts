/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

// The recorder runs entirely under withService (BYPASSRLS) after the calling
// action has authorised the actor — see the header of record.ts.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("next/server", () => ({ after: vi.fn((fn: any) => fn()) }));

import { recordEvent } from "./record";
import { withService } from "@/lib/db/client";
import {
  activityEvents,
  notificationEmailQueue,
  notifications,
} from "@/drizzle/schema";

const STORE = "store-1";
const EVENT_ID = "event-1";

describe("watch outbox shared transaction", () => {
  it("reuses the transaction instead of acquiring another connection", async () => {
    const mock = setupDb({});
    vi.mocked(withService).mockClear();
    await expect(
      recordEvent({ type: "mink.watch_ready", storeId: STORE }, mock.db),
    ).resolves.toBe(EVENT_ID);
    expect(withService).not.toHaveBeenCalled();
  });
  it("propagates delivery failures so the outbox transaction rolls back", async () => {
    const mock = setupDb({});
    mock.db.insert.mockImplementation(() => {
      throw new Error("delivery failed");
    });
    await expect(
      recordEvent({ type: "mink.watch_ready", storeId: STORE }, mock.db),
    ).rejects.toThrow("delivery failed");
  });
  it("refuses a shared transaction for other notification types", async () => {
    const mock = setupDb({});
    await expect(
      recordEvent({ type: "order.placed", storeId: STORE }, mock.db),
    ).rejects.toThrow("Only Mink watch");
  });
});

/**
 * The recorder reads in a fixed order, and the mock's select queue must match:
 *   1. notification_definitions (platform overrides for this key)
 *   2. notification_settings    (this store's configuration — incl. routing)
 *   3. staff, 4. roles          (the permission-derived recipient set)
 *   5. the recipients' personal overrides
 *   6. the customer's email address — read lazily, ONLY when a customer is in
 *      the recipient list and the email channel is on for them.
 * For a PLATFORM event (no store) step 2 is skipped and step 3 is the
 * platform_admins lookup instead.
 */
function setupDb(opts: {
  definition?: any[];
  settings?: any[];
  staff?: any[];
  roles?: any[];
  /** admin_locations rows — empty means every admin is unrestricted. */
  adminLocations?: any[];
  prefs?: any[];
  customerEmail?: string;
}) {
  dbHolder.current = makeDbMock({
    returning: [{ id: EVENT_ID }],
    selectQueue: [
      opts.definition ?? [],
      opts.settings ?? [],
      opts.staff ?? [],
      opts.roles ?? [],
      opts.adminLocations ?? [],
      opts.prefs ?? [],
      opts.customerEmail ? [{ email: opts.customerEmail }] : [],
    ],
  });
  return dbHolder.current;
}

/** A notification_settings row with sensible defaults. */
function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    eventKey: "order.placed",
    channels: {},
    routing: "permission",
    targetRoles: [],
    targetAdmins: [],
    templates: {},
    digest: "instant",
    isEnabled: true,
    ...overrides,
  };
}

const superadmin = {
  id: "uid-owner",
  email: "owner@store.com",
  role: "superadmin",
  firstName: "Owner",
  lastName: "One",
};

/** The rows handed to insert(notificationEmailQueue).values(...), flattened. */
function queuedEmails(mock: any) {
  const idx = mock.calls.insert.findIndex(
    (t: any) => t === notificationEmailQueue,
  );
  if (idx === -1) return [];
  const rows = mock.calls.values[idx];
  return Array.isArray(rows) ? rows : [rows];
}

/** The rows handed to insert(notifications).values(...), flattened. */
function fannedOut(mock: any) {
  const idx = mock.calls.insert.findIndex((t: any) => t === notifications);
  if (idx === -1) return [];
  const rows = mock.calls.values[idx];
  return Array.isArray(rows) ? rows : [rows];
}

describe("recordEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records the event and fans it out to eligible staff", async () => {
    const mock = setupDb({ staff: [superadmin] });

    const id = await recordEvent({
      type: "order.placed",
      storeId: STORE,
      actor: { type: "customer", id: "cust-1", label: "Priya S." },
      subject: { type: "order", id: "order-1", label: "ORD10010004" },
      payload: { total: 1240 },
    });

    expect(id).toBe(EVENT_ID);
    expect(mock.calls.insert[0]).toBe(activityEvents);

    const rows = fannedOut(mock);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientId: "uid-owner",
      recipientType: "admin",
      type: "order.placed",
      storeId: STORE,
      eventId: EVENT_ID,
    });
    expect(rows[0].title).toContain("ORD10010004");
  });

  // ★★ NARROWING ONLY, AND LAST. `restrictToAdminIds` exists for an event that
  // is genuinely about one admin's own request — a Mink workflow they queued —
  // rather than news the whole team needs. It is applied AFTER the section
  // permission filter and the store's routing rule, so it obeys the same floor
  // everything else does: it can remove people, never add them.
  describe("restrictToAdminIds", () => {
    const manager = {
      id: "uid-manager",
      email: "manager@store.com",
      role: "manager",
      firstName: "Meera",
      lastName: "K",
    };
    const managerRole = {
      slug: "manager",
      permissions: { dashboard: ["view"], orders: ["manage"] },
    };

    it("delivers only to the named admin", async () => {
      const mock = setupDb({
        staff: [superadmin, manager],
        roles: [managerRole],
      });

      await recordEvent({
        type: "mink.workflow_completed",
        storeId: STORE,
        subject: {
          type: "mink_workflow",
          id: "wf-1",
          label: "Delayed pickup review",
        },
        payload: { url: "/dashboard/orders" },
        restrictToAdminIds: ["uid-manager"],
      });

      const rows = fannedOut(mock);
      expect(rows.map((r: any) => r.recipientId)).toEqual(["uid-manager"]);
    });

    it("tells everyone eligible when it is omitted", async () => {
      // The unrestricted path must be untouched, or every other event changes.
      const mock = setupDb({
        staff: [superadmin, manager],
        roles: [managerRole],
      });

      await recordEvent({
        type: "mink.workflow_completed",
        storeId: STORE,
        subject: { type: "mink_workflow", id: "wf-1", label: "Weekly report" },
      });

      expect(
        fannedOut(mock)
          .map((r: any) => r.recipientId)
          .sort(),
      ).toEqual(["uid-manager", "uid-owner"]);
    });

    it("cannot add somebody the permission filter already excluded", async () => {
      // Naming an admin who is not in the eligible set delivers to nobody, not
      // to them — targeting narrows, it never widens (routing.ts).
      const mock = setupDb({ staff: [superadmin] });

      await recordEvent({
        type: "mink.workflow_completed",
        storeId: STORE,
        subject: { type: "mink_workflow", id: "wf-1", label: "Weekly report" },
        restrictToAdminIds: ["uid-not-an-admin"],
      });

      expect(fannedOut(mock)).toHaveLength(0);
    });
  });

  it("also notifies the customer when the event names one", async () => {
    const mock = setupDb({ staff: [superadmin] });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "order-1", label: "ORD10010004" },
    });

    const rows = fannedOut(mock);
    expect(rows.map((r: any) => r.recipientType).sort()).toEqual([
      "admin",
      "customer",
    ]);
    // Same event, different copy per audience.
    const customerRow = rows.find((r: any) => r.recipientType === "customer");
    expect(customerRow.title).toBe("Order confirmed");
  });

  // Routing derives from the permission map: staff who can't see Orders
  // shouldn't be paged about them.
  it("skips staff whose role lacks view on the event's section", async () => {
    const mock = setupDb({
      staff: [
        superadmin,
        {
          id: "uid-writer",
          email: "writer@store.com",
          role: "editor",
          firstName: "Blog",
          lastName: "Writer",
        },
      ],
      roles: [{ slug: "editor", permissions: { blogs: ["view", "manage"] } }],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });

    const rows = fannedOut(mock);
    expect(rows.map((r: any) => r.recipientId)).toEqual(["uid-owner"]);
  });

  it("includes staff whose role DOES grant view on the section", async () => {
    const mock = setupDb({
      staff: [
        {
          id: "uid-ops",
          email: "ops@store.com",
          role: "ops",
          firstName: "Ops",
          lastName: null,
        },
      ],
      roles: [{ slug: "ops", permissions: { orders: ["view"] } }],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });
    expect(fannedOut(mock).map((r: any) => r.recipientId)).toEqual(["uid-ops"]);
  });

  it("records audit-only events without notifying anyone", async () => {
    const mock = setupDb({ staff: [superadmin] });

    const id = await recordEvent({
      type: "product.updated",
      storeId: STORE,
      subject: { type: "product", id: "p1", label: "Cold Brew" },
    });

    expect(id).toBe(EVENT_ID);
    expect(mock.calls.insert).toEqual([activityEvents]);
    expect(fannedOut(mock)).toHaveLength(0);
  });

  it("honours a user's opt-out", async () => {
    const mock = setupDb({
      staff: [superadmin],
      prefs: [
        {
          scope: "user",
          recipientId: "uid-owner",
          inApp: false,
          email: false,
          digest: null,
        },
      ],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });
    expect(fannedOut(mock)).toHaveLength(0);
  });

  // Regression: the store default is a STAFF setting. It used to be applied to
  // every audience, so switching off "New order" email for the team silently
  // stopped shoppers receiving their order confirmation too.
  it("never lets a store default govern customer mail", async () => {
    const mock = setupDb({
      staff: [superadmin],
      settings: [settingsRow({ channels: { email: false, web: false } })],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "order-1", label: "ORD10010004" },
    });

    const rows = fannedOut(mock);
    // Staff opted out; the shopper still gets their confirmation.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: "customer",
      recipientId: "cust-1",
    });
  });

  // A store owner ordering from their own store is staff AND the customer.
  it("sends one notification to someone who is both staff and the customer", async () => {
    const mock = setupDb({ staff: [superadmin] });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "uid-owner",
      subject: { type: "order", id: "order-1", label: "ORD10010004" },
    });

    const rows = fannedOut(mock);
    expect(rows).toHaveLength(1);
    // The admin copy wins — it's the one that links into the dashboard.
    expect(rows[0]).toMatchObject({ recipientType: "admin" });
  });

  it("ignores an opt-out on a non-configurable event", async () => {
    const mock = setupDb({
      staff: [superadmin],
      prefs: [
        {
          scope: "user",
          recipientId: "uid-owner",
          inApp: false,
          email: false,
          digest: null,
        },
      ],
    });

    await recordEvent({ type: "admin.role_changed", storeId: STORE });
    expect(fannedOut(mock)).toHaveLength(1);
  });

  // ── Store routing (routing.ts) ─────────────────────────────────────────
  it("narrows delivery to the roles the store selected", async () => {
    const mock = setupDb({
      settings: [
        settingsRow({
          routing: "roles",
          targetRoles: ["ops"],
          targetAdmins: [],
        }),
      ],
      staff: [
        superadmin,
        {
          id: "uid-ops",
          email: "ops@s.com",
          role: "ops",
          firstName: "O",
          lastName: null,
        },
      ],
      roles: [{ slug: "ops", permissions: { orders: ["view"] } }],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });

    // The owner can view Orders, but the store routed this event to Ops only.
    expect(fannedOut(mock).map((r: any) => r.recipientId)).toEqual(["uid-ops"]);
  });

  it("narrows delivery to the individuals the store selected", async () => {
    const mock = setupDb({
      settings: [
        settingsRow({
          routing: "admins",
          targetRoles: [],
          targetAdmins: ["uid-ops"],
        }),
      ],
      staff: [
        superadmin,
        {
          id: "uid-ops",
          email: "ops@s.com",
          role: "ops",
          firstName: "O",
          lastName: null,
        },
      ],
      roles: [{ slug: "ops", permissions: { orders: ["view"] } }],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });
    expect(fannedOut(mock).map((r: any) => r.recipientId)).toEqual(["uid-ops"]);
  });

  // Routing chooses among those already allowed; it is never a way around the
  // permission gate. A notification's copy IS order data.
  it("cannot route an event to someone who lacks the section permission", async () => {
    const mock = setupDb({
      settings: [
        settingsRow({
          routing: "admins",
          targetRoles: [],
          targetAdmins: ["uid-blogger"],
        }),
      ],
      staff: [
        superadmin,
        {
          id: "uid-blogger",
          email: "blog@s.com",
          role: "blogger",
          firstName: "B",
          lastName: null,
        },
      ],
      roles: [{ slug: "blogger", permissions: { blogs: ["view"] } }],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });
    // Nobody: the only targeted person isn't allowed to see orders.
    expect(fannedOut(mock)).toHaveLength(0);
  });

  // An unfinished selection must not silently black-hole a store's alerts.
  it("falls back to everyone eligible when the rule targets nobody", async () => {
    const mock = setupDb({
      settings: [
        settingsRow({
          routing: "roles",
          targetRoles: [],
          targetAdmins: [],
        }),
      ],
      staff: [superadmin],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });
    expect(fannedOut(mock).map((r: any) => r.recipientId)).toEqual([
      "uid-owner",
    ]);
  });

  it("still delivers to the customer when routing narrows the staff list", async () => {
    const mock = setupDb({
      settings: [
        settingsRow({
          routing: "admins",
          targetRoles: [],
          targetAdmins: ["uid-nobody"],
        }),
      ],
      staff: [superadmin],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
    });

    const rows = fannedOut(mock);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipientType: "customer" });
  });

  // ── Console configuration (config.ts) ──────────────────────────────────
  it("stops notifying when the store switches a notification off", async () => {
    const mock = setupDb({
      staff: [superadmin],
      settings: [settingsRow({ isEnabled: false })],
    });

    const id = await recordEvent({ type: "order.placed", storeId: STORE });

    // Still AUDITED — the trail must stay complete even when nobody is told.
    expect(id).toBe(EVENT_ID);
    expect(mock.calls.insert).toEqual([activityEvents]);
    expect(fannedOut(mock)).toHaveLength(0);
  });

  it("cannot switch off a notification the registry marks always-on", async () => {
    const mock = setupDb({
      staff: [superadmin],
      settings: [
        settingsRow({ eventKey: "admin.role_changed", isEnabled: false }),
      ],
    });

    await recordEvent({ type: "admin.role_changed", storeId: STORE });
    expect(fannedOut(mock)).toHaveLength(1);
  });

  it("respects a channel the store turned on", async () => {
    const mock = setupDb({
      staff: [superadmin],
      // page.published defaults to OFF on both channels in the registry.
      settings: [
        settingsRow({ eventKey: "page.published", channels: { web: true } }),
      ],
    });

    await recordEvent({ type: "page.published", storeId: STORE });
    expect(fannedOut(mock)).toHaveLength(1);
  });

  it("drops a notification an operator retired platform-wide", async () => {
    const mock = setupDb({
      definition: [
        {
          key: "order.placed",
          isActive: false,
          isCustom: false,
          channels: null,
        },
      ],
      staff: [superadmin],
    });

    await recordEvent({ type: "order.placed", storeId: STORE });
    expect(fannedOut(mock)).toHaveLength(0);
  });

  it("uses the store's own email copy when it has written some", async () => {
    const mock = setupDb({
      staff: [superadmin],
      settings: [
        settingsRow({
          templates: {
            email: { subject: "Order {{subject_label}} is in!" },
          },
        }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    // The EMAIL carries the merchant's subject...
    expect(queuedEmails(mock)[0].title).toBe("Order ORD10010004 is in!");
    // ...while the bell keeps its own short line (different channel, different
    // template — a 60-character bell line and an email are not the same copy).
    expect(fannedOut(mock)[0].title).toContain("New order");
  });

  it("uses the store's own WEB copy for the bell", async () => {
    const mock = setupDb({
      staff: [superadmin],
      settings: [
        settingsRow({
          templates: { web: { subject: "Ka-ching! {{subject_label}}" } },
        }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    expect(fannedOut(mock)[0].title).toBe("Ka-ching! ORD10010004");
  });

  // ★ An order placed on 5 August 2026 was confirmed to the customer as
  // "8 May 2026". The envelope handed `date` to templateValues ALREADY
  // formatted as an en-IN locale string, which formatVariable then re-parsed
  // the American way — D/M/Y read as M/D/Y. The envelope must carry the stored
  // shape (ISO), like every other value; formatting happens in one place.
  it("renders {{date}} as the day it actually happened", async () => {
    // Fake only Date — faking timers would hang the awaits below.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-05T04:12:46.000Z")); // 9:42 am IST
    try {
      const mock = setupDb({
        staff: [superadmin],
        settings: [
          settingsRow({ templates: { web: { subject: "Placed {{date}}" } } }),
        ],
      });

      await recordEvent({
        type: "order.placed",
        storeId: STORE,
        subject: { type: "order", id: "o1", label: "ORD10010004" },
      });

      expect(fannedOut(mock)[0].title).toBe("Placed 5 August 2026 at 9:42 am");
    } finally {
      vi.useRealTimers();
    }
  });

  // A merchant customises what their TEAM is told; a shopper's confirmation
  // keeps the platform's tested copy.
  it("never applies merchant copy to the customer's notification", async () => {
    const mock = setupDb({
      staff: [superadmin],
      customerEmail: "priya@example.com",
      settings: [
        settingsRow({
          templates: { email: { subject: "STAFF: {{subject_label}}" } },
        }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      // Named, so "Who" has something to say — an actorless event now drops
      // the row rather than printing the label above nothing.
      actor: { type: "customer", id: "cust-1", label: "Priya S." },
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    const mails = queuedEmails(mock);
    const customer = mails.find((r: any) => r.recipientType === "customer");
    const admin = mails.find((r: any) => r.recipientType === "admin");

    expect(admin.title).toBe("STAFF: ORD10010004");
    // The shopper gets the CUSTOMER default, written in their voice — never
    // the team's wording, and never the team's template.
    expect(customer.title).not.toContain("STAFF:");
    expect(customer.title).toContain("Order ORD10010004 confirmed");
    expect(customer.body).toContain("Thank you for your order");
    // The shopper already knows who they are; only team mail names them.
    expect(customer.body).not.toContain(">Customer</strong>");
    expect(admin.body).toContain(">Customer</strong>");
  });

  // ★ A LABEL WITH NOTHING UNDER IT IS WORSE THAN NO ROW. The fact list is
  // generated from the variable CATALOG, which declares everything an event
  // COULD carry — so "Ready to collect" went out with "Pickup location" and
  // "Pickup address" as two empty rows when the emitter supplied neither.
  it("omits a fact the emitter didn't supply", async () => {
    const mock = setupDb({
      staff: [superadmin],
      customerEmail: "priya@example.com",
    });

    await recordEvent({
      type: "order.ready_for_pickup",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "o1", label: "ORD10010004" },
      payload: { pickupLocation: "Connaught Place" },
    });

    const mail = queuedEmails(mock).find(
      (r: any) => r.recipientType === "customer",
    );
    expect(mail.body).toContain(">Pickup location</strong>");
    expect(mail.body).toContain("Connaught Place");
    // Declared for this event, but not supplied here.
    expect(mail.body).not.toContain(">Address</strong>");
  });

  it("falls back to built-in copy for a field the merchant left blank", async () => {
    const mock = setupDb({
      staff: [superadmin],
      settings: [
        settingsRow({ templates: { email: { subject: "Custom subject" } } }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      actor: { type: "customer", label: "Priya S." },
      subject: { type: "order", id: "o1", label: "ORD10010004" },
      payload: { total: 1240 },
    });

    const row = queuedEmails(mock)[0];
    expect(row.title).toBe("Custom subject");
    // Body was not overridden, so the built-in DEFAULT email body is used —
    // which lays the facts out as "Label: value" lines.
    expect(row.body).toContain("Priya S.");
    // The default body is HTML with the facts as list rows.
    expect(row.body).toContain(">Order</strong>");
    expect(row.body).toContain("ORD10010004");
  });

  // The email body is the full default, not the bell's one-liner.
  it("queues the rich default email body when nothing is customised", async () => {
    const mock = setupDb({ staff: [superadmin] });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      actor: { type: "customer", label: "Priya S." },
      subject: { type: "order", id: "o1", label: "ORD10010004" },
      payload: { total: 1240, currency: "INR" },
    });

    const mail = queuedEmails(mock)[0];
    expect(mail.title).toContain("ORD10010004");
    expect(mail.body).toContain("A new order is ready for review.");
    expect(mail.body).toContain("Priya S.");
    // Money and items are NOT in the fact list for an order: the rendered
    // order summary (lib/email/line-items.ts) shows them in full, and printing
    // "Total ₹1,240.00" directly above a table ending in the same total is the
    // duplication that makes an email look auto-generated.
    expect(mail.body).not.toContain(">Total</strong>");
    expect(mail.body).not.toContain(">Items</strong>");
    // The bell stays short — one line, no markup.
    expect(fannedOut(mock)[0].body).not.toContain("<ul>");
  });

  // The exclusion above is scoped to events the summary table actually covers.
  // An event without one keeps every fact it declares, or hiding rows for
  // order.placed would have quietly emptied other emails too.
  it("keeps its fact rows for an event with no order summary", async () => {
    const mock = setupDb({ staff: [superadmin] });

    await recordEvent({
      type: "order.payment_failed",
      storeId: STORE,
      actor: { type: "system" },
      subject: { type: "order", id: "o1", label: "ORD10010004" },
      payload: { reason: "Card declined" },
    });

    const mail = queuedEmails(mock)[0];
    expect(mail.body).toContain(">Reason</strong>");
    expect(mail.body).toContain("Card declined");
  });

  // The body is HTML, so substituted values must be escaped — a customer name
  // is DB-derived and must never become markup in an email.
  it("escapes substituted values into the HTML body", async () => {
    const mock = setupDb({ staff: [superadmin] });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      actor: { type: "customer", label: "<script>alert(1)</script>" },
      subject: { type: "order", id: "o1", label: "ORD1" },
    });

    const body = queuedEmails(mock)[0].body;
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("snapshots the store's Cc/Bcc onto staff mail only", async () => {
    const mock = setupDb({
      staff: [superadmin],
      customerEmail: "priya@example.com",
      settings: [
        settingsRow({
          templates: { email: { cc: "ops@acme.com", bcc: "archive@acme.com" } },
        }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    const mails = queuedEmails(mock);
    const admin = mails.find((r: any) => r.recipientType === "admin");
    const customer = mails.find((r: any) => r.recipientType === "customer");
    expect(admin.cc).toBe("ops@acme.com");
    expect(admin.bcc).toBe("archive@acme.com");
    // A shopper's confirmation must never be copied to the team.
    expect(customer.cc).toBeNull();
    expect(customer.bcc).toBeNull();
  });

  // ── Per-audience configuration ─────────────────────────────────────────
  // Team and customer are configured separately. A merchant silencing their
  // team must never silence the shopper's confirmation, and vice versa.
  it("silences the team without touching the customer", async () => {
    const mock = setupDb({
      staff: [superadmin],
      customerEmail: "priya@example.com",
      settings: [
        settingsRow({
          channels: { team: { email: false, web: false } },
        }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    expect(fannedOut(mock).map((r: any) => r.recipientType)).toEqual([
      "customer",
    ]);
  });

  it("silences the customer without touching the team", async () => {
    const mock = setupDb({
      staff: [superadmin],
      customerEmail: "priya@example.com",
      settings: [
        settingsRow({
          channels: { customer: { email: false, web: false } },
        }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    expect(fannedOut(mock).map((r: any) => r.recipientType)).toEqual(["admin"]);
  });

  it("applies each audience's own template", async () => {
    const mock = setupDb({
      staff: [superadmin],
      customerEmail: "priya@example.com",
      settings: [
        settingsRow({
          templates: {
            team: { email: { subject: "TEAM {{subject_label}}" } },
            customer: { email: { subject: "HELLO {{subject_label}}" } },
          },
        }),
      ],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    const mails = queuedEmails(mock);
    expect(mails.find((m: any) => m.recipientType === "admin").title).toBe(
      "TEAM ORD10010004",
    );
    expect(mails.find((m: any) => m.recipientType === "customer").title).toBe(
      "HELLO ORD10010004",
    );
  });

  // Settings saved before audiences became first-class were a flat
  // {"email": …} map, which always meant the team.
  it("reads a legacy flat channel map as the team's", async () => {
    const mock = setupDb({
      staff: [superadmin],
      customerEmail: "priya@example.com",
      settings: [settingsRow({ channels: { email: false, web: false } })],
    });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      customerId: "cust-1",
      subject: { type: "order", id: "o1", label: "ORD10010004" },
    });

    expect(fannedOut(mock).map((r: any) => r.recipientType)).toEqual([
      "customer",
    ]);
  });

  it("ignores an unknown event type instead of writing junk", async () => {
    const mock = setupDb({ staff: [superadmin] });
    const id = await recordEvent({ type: "order.teleported" as never });
    expect(id).toBeNull();
    expect(mock.calls.insert).toHaveLength(0);
  });

  // Rule 1 in record.ts: bookkeeping must never break the thing it reports on.
  it("swallows a database failure and returns null", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: EVENT_ID }],
      failInsertFor: [activityEvents],
    });

    await expect(
      recordEvent({ type: "order.placed", storeId: STORE }),
    ).resolves.toBeNull();
  });

  it("drops nested payload values and caps long strings", async () => {
    const mock = setupDb({ staff: [] });

    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      payload: {
        total: 100,
        nested: { secret: "no" },
        list: [1, 2, 3],
        long: "x".repeat(900),
      },
    });

    const eventRow = mock.calls.values[0];
    expect(eventRow.payload).toHaveProperty("total", 100);
    expect(eventRow.payload).not.toHaveProperty("nested");
    expect(eventRow.payload).not.toHaveProperty("list");
    expect((eventRow.payload.long as string).length).toBe(500);
  });

  // A platform event goes to StoreMink operators only — never into a store's
  // own feed — and operators are keyed by lowercased EMAIL, because
  // platform_admins is an email allowlist with no uid (see the RLS policy).
  it("routes platform events to operators, keyed by email", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: EVENT_ID }],
      // storeId is null: definitions, then platform_admins, then preferences
      // (the store settings + staff lookups are skipped entirely).
      selectQueue: [[], [{ email: "Ops@StoreMink.com" }], []],
    });
    const mock = dbHolder.current;

    await recordEvent({
      type: "platform.store_created",
      storeId: null,
      subject: { type: "store", id: "s2", label: "New Store" },
    });

    expect(mock.calls.values[0].storeId).toBeNull();
    const rows = fannedOut(mock);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: "operator",
      recipientId: "ops@storemink.com",
      storeId: null,
    });
  });

  it("never fans a store event out to operators", async () => {
    const mock = setupDb({ staff: [superadmin] });
    await recordEvent({ type: "order.placed", storeId: STORE });
    expect(
      fannedOut(mock).some((r: any) => r.recipientType === "operator"),
    ).toBe(false);
  });
});

// Location-aware routing (roadmap §1.5). The pure composition is covered in
// routing.test.ts; this proves the fan-out actually threads the event's
// location and each admin's bindings through to it.
describe("recordEvent — location scope", () => {
  const DELHI = "loc-delhi";
  const staffRows = [
    {
      id: "uid-delhi",
      email: "d@x.com",
      role: "member",
      firstName: "D",
      lastName: null,
    },
    {
      id: "uid-mumbai",
      email: "m@x.com",
      role: "member",
      firstName: "M",
      lastName: null,
    },
  ];

  it("reaches every admin under the default store scope", async () => {
    const mock = setupDb({
      settings: [settingsRow()],
      staff: staffRows,
      adminLocations: [{ admin_id: "uid-mumbai", location_id: "loc-mumbai" }],
    });
    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      locationId: DELHI,
    });
    expect(fannedOut(mock).length).toBeGreaterThanOrEqual(2);
  });

  // THE point: Mumbai's manager stops being emailed about a Delhi sale.
  it("narrows to the event's location when scoped", async () => {
    const mock = setupDb({
      settings: [settingsRow({ routingScope: "event_location" })],
      staff: staffRows,
      adminLocations: [
        { admin_id: "uid-delhi", location_id: DELHI },
        { admin_id: "uid-mumbai", location_id: "loc-mumbai" },
      ],
    });
    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      locationId: DELHI,
    });
    const ids = fannedOut(mock).map((r: any) => r.recipientId);
    expect(ids).toContain("uid-delhi");
    expect(ids).not.toContain("uid-mumbai");
  });

  // An online order before routing resolves one, a blog comment, a plan change:
  // narrowing by a location it hasn't got would black-hole the alert.
  it("does not narrow an event with no location", async () => {
    const mock = setupDb({
      settings: [settingsRow({ routingScope: "event_location" })],
      staff: staffRows,
      adminLocations: [
        { admin_id: "uid-delhi", location_id: DELHI },
        { admin_id: "uid-mumbai", location_id: "loc-mumbai" },
      ],
    });
    await recordEvent({ type: "order.placed", storeId: STORE });
    expect(fannedOut(mock).length).toBeGreaterThanOrEqual(2);
  });

  // Absence is not restriction — an admin nobody has assigned hears everything.
  it("still reaches unassigned admins when scoped", async () => {
    const mock = setupDb({
      settings: [settingsRow({ routingScope: "event_location" })],
      staff: staffRows,
      adminLocations: [{ admin_id: "uid-mumbai", location_id: "loc-mumbai" }],
    });
    await recordEvent({
      type: "order.placed",
      storeId: STORE,
      locationId: DELHI,
    });
    const ids = fannedOut(mock).map((r: any) => r.recipientId);
    expect(ids).toContain("uid-delhi");
    expect(ids).not.toContain("uid-mumbai");
  });
});
