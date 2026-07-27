/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

// Resend: capture what would be sent, and let each test decide the outcome.
const resendHolder = vi.hoisted(() => ({
  sent: [] as any[][],
  error: null as { message: string } | null,
  throws: false,
  /** Addresses the API genuinely refuses — the rest of a batch is fine. */
  badTo: [] as string[],
  /** Individual (fallback) sends, in order, so a test can assert the probe. */
  individual: [] as string[],
}));
vi.mock("resend", () => ({
  Resend: class {
    batch = {
      send: async (messages: any[]) => {
        if (resendHolder.throws) throw new Error("network down");
        const bad = messages.find((m) => resendHolder.badTo.includes(m.to));
        if (bad) return { error: { message: `Invalid recipient: ${bad.to}` } };
        resendHolder.sent.push(messages);
        return { error: resendHolder.error };
      },
    };
    emails = {
      send: async (message: any) => {
        if (resendHolder.throws) throw new Error("network down");
        resendHolder.individual.push(message.to);
        if (resendHolder.badTo.includes(message.to)) {
          return { error: { message: `Invalid recipient: ${message.to}` } };
        }
        resendHolder.sent.push([message]);
        return { error: resendHolder.error };
      },
    };
  },
}));

vi.mock("@/lib/store/resolve", () => ({
  lookupStoreById: vi.fn(async (id: string) =>
    id === "missing-store"
      ? null
      : { id, slug: "acme", custom_domain: null, name: "Acme Juice" },
  ),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrandById: vi.fn(async () => ({
    name: "Acme Juice",
    logoUrl: null,
    primaryColor: "#123456",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: { instagram: null, youtube: null, whatsapp: null },
    badges: [],
    domain: "acme.storemink.com",
  })),
  brandFromSettings: (_s: any, name: string, domain: string) => ({
    name,
    logoUrl: null,
    primaryColor: "#17130f",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: { instagram: null, youtube: null, whatsapp: null },
    badges: [],
    domain,
  }),
}));

import { processNotificationEmails } from "./notification-worker";
import { notificationEmailQueue } from "@/drizzle/schema";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "q1",
    store_id: "store-1",
    recipient_id: "uid-owner",
    email: "owner@acme.com",
    cc: null,
    bcc: null,
    digest: "instant",
    title: "New order ORD10010004",
    body: "₹1,240",
    url: "/dashboard/orders",
    severity: "success",
    attempts: 1,
    created_at: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * execute() queue: requeue_stale, then claim.
 * select() queue: the suppression lookup, then the countDue tally.
 */
function setupQueue(rows: any[], due = 0, suppressed: string[] = []) {
  dbHolder.current = makeDbMock({
    executeQueue: [[], rows],
    selectQueue: [suppressed.map((email) => ({ email })), [{ n: due }]],
  });
  return dbHolder.current;
}

describe("processNotificationEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resendHolder.sent = [];
    resendHolder.error = null;
    resendHolder.throws = false;
    resendHolder.badTo = [];
    resendHolder.individual = [];
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NEXT_PUBLIC_APP_URL = "https://storemink.com";
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it("does nothing (and marks nothing sent) without an API key", async () => {
    delete process.env.RESEND_API_KEY;
    const mock = setupQueue([row()]);
    const result = await processNotificationEmails();
    expect(result).toMatchObject({ processed: 0, sent: 0 });
    expect(mock.calls.update).toHaveLength(0);
  });

  it("sends one email per row when rows are unrelated", async () => {
    setupQueue([
      row({ id: "q1", recipient_id: "uid-a", email: "a@acme.com" }),
      row({ id: "q2", recipient_id: "uid-b", email: "b@acme.com" }),
    ]);

    const result = await processNotificationEmails();

    expect(result.processed).toBe(2);
    expect(result.sent).toBe(2);
    expect(resendHolder.sent[0]).toHaveLength(2);
    expect(resendHolder.sent[0].map((m: any) => m.to).sort()).toEqual([
      "a@acme.com",
      "b@acme.com",
    ]);
  });

  // The whole point of digests: many rows for one person → ONE email.
  it("collapses one recipient's rows into a single digest email", async () => {
    setupQueue([
      row({ id: "q1", digest: "daily", title: "New order A" }),
      row({ id: "q2", digest: "daily", title: "New order B" }),
      row({ id: "q3", digest: "daily", title: "Low stock · Cold Brew" }),
    ]);

    const result = await processNotificationEmails();

    expect(result.processed).toBe(3);
    expect(result.sent).toBe(1);
    const messages = resendHolder.sent[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe("3 updates from Acme Juice");
    expect(messages[0].html).toContain("New order A");
    expect(messages[0].html).toContain("Low stock · Cold Brew");
  });

  it("keeps different recipients' digests separate", async () => {
    setupQueue([
      row({ id: "q1", recipient_id: "uid-a", email: "a@acme.com" }),
      row({ id: "q2", recipient_id: "uid-a", email: "a@acme.com" }),
      row({ id: "q3", recipient_id: "uid-b", email: "b@acme.com" }),
    ]);

    const result = await processNotificationEmails();
    expect(result.sent).toBe(2);
    expect(resendHolder.sent[0]).toHaveLength(2);
  });

  it("marks the queue rows sent on success", async () => {
    const mock = setupQueue([row()]);
    await processNotificationEmails();

    expect(mock.calls.update).toContain(notificationEmailQueue);
    expect(mock.calls.set[0]).toMatchObject({ status: "sent" });
  });

  // A bad minute at Resend must not cost a merchant their order notification.
  it("retries — not fails — when a send errors and attempts remain", async () => {
    resendHolder.error = { message: "rate limited" };
    const mock = setupQueue([row({ attempts: 1 })]);

    const result = await processNotificationEmails();

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect(mock.calls.set[0]).toMatchObject({
      status: "pending",
      lastError: "rate limited",
    });
  });

  it("parks a row as failed once its attempts are exhausted", async () => {
    resendHolder.error = { message: "still broken" };
    const mock = setupQueue([row({ attempts: 3 })]);

    const result = await processNotificationEmails();

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    expect(mock.calls.set[0]).toMatchObject({ status: "failed" });
  });

  it("survives the send throwing outright", async () => {
    resendHolder.throws = true;
    const mock = setupQueue([row({ attempts: 1 })]);

    const result = await processNotificationEmails();
    expect(result.sent).toBe(0);
    expect(result.retried).toBe(1);
    expect(mock.calls.set[0]?.lastError).toContain("network down");
  });

  // Mail pointing at a dead host helps nobody.
  it("fails rows whose store no longer resolves", async () => {
    const mock = setupQueue([row({ store_id: "missing-store" })]);

    const result = await processNotificationEmails();

    expect(result.failed).toBe(1);
    expect(resendHolder.sent).toHaveLength(0);
    expect(mock.calls.set[0]).toMatchObject({ status: "failed" });
  });

  it("sends platform rows from the StoreMink brand", async () => {
    setupQueue([
      row({
        store_id: null,
        recipient_id: "ops@storemink.com",
        email: "ops@storemink.com",
      }),
    ]);

    const result = await processNotificationEmails();
    expect(result.sent).toBe(1);
    expect(resendHolder.sent[0][0].from).toContain("StoreMink");
  });

  // Cc/Bcc were collected by the console and silently dropped before this.
  it("passes Cc and Bcc through to the send", async () => {
    setupQueue([
      row({ cc: "ops@acme.com, finance@acme.com", bcc: "archive@acme.com" }),
    ]);

    await processNotificationEmails();

    const message = resendHolder.sent[0][0];
    expect(message.cc).toEqual(["ops@acme.com", "finance@acme.com"]);
    expect(message.bcc).toEqual(["archive@acme.com"]);
  });

  it("omits the fields entirely when no copy line is set", async () => {
    setupQueue([row()]);
    await processNotificationEmails();
    const message = resendHolder.sent[0][0];
    expect(message).not.toHaveProperty("cc");
    expect(message).not.toHaveProperty("bcc");
  });

  // REGRESSION. Resend rejects a whole batch over ONE bad recipient. Reading
  // that as "all of them failed" meant a single typo'd Cc could cost every
  // other person in the same batch their notification — and after three
  // attempts, permanently. Only the bad one may fail.
  it("does not let one bad recipient sink the rest of the batch", async () => {
    resendHolder.badTo = ["broken@@acme.com"];
    const mock = setupQueue([
      row({ id: "q1", recipient_id: "uid-a", email: "a@acme.com" }),
      row({ id: "q2", recipient_id: "uid-b", email: "broken@@acme.com" }),
      row({ id: "q3", recipient_id: "uid-c", email: "c@acme.com" }),
    ]);

    const result = await processNotificationEmails();

    // Two delivered, one retried — not three written off.
    expect(result.sent).toBe(2);
    expect(result.retried).toBe(1);
    expect(
      resendHolder.sent
        .flat()
        .map((m: any) => m.to)
        .sort(),
    ).toEqual(["a@acme.com", "c@acme.com"]);

    // The good rows are marked sent; only the bad one goes back to pending.
    const sentUpdate = mock.calls.set.find((s: any) => s.status === "sent");
    const retryUpdate = mock.calls.set.find(
      (s: any) => s.status === "pending" && s.claimedAt === null,
    );
    expect(sentUpdate).toBeTruthy();
    expect(retryUpdate).toBeTruthy();
    // ...and its error names ITS problem, not the batch's.
    expect(String(retryUpdate.lastError)).toContain("broken@@acme.com");
  });

  it("records the bad recipient's own error when its retries are spent", async () => {
    resendHolder.badTo = ["broken@@acme.com"];
    const mock = setupQueue([
      row({ id: "q1", recipient_id: "uid-a", email: "a@acme.com" }),
      row({
        id: "q2",
        recipient_id: "uid-b",
        email: "broken@@acme.com",
        attempts: 3,
      }),
    ]);

    const result = await processNotificationEmails();

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    const failedUpdate = mock.calls.set.find((s: any) => s.status === "failed");
    expect(String(failedUpdate.lastError)).toContain("broken@@acme.com");
  });

  // Handing a message to Resend is not delivery. A hard-bounced address used to
  // be re-mailed on every future notification forever — the send "succeeded",
  // the row was marked sent, and the mail landed nowhere, spending the SHARED
  // sending domain's reputation each time.
  it("never mails an address the provider has told us is dead", async () => {
    const mock = setupQueue(
      [
        row({ id: "q1", recipient_id: "uid-a", email: "live@acme.com" }),
        row({ id: "q2", recipient_id: "uid-b", email: "dead@acme.com" }),
      ],
      0,
      ["dead@acme.com"],
    );

    const result = await processNotificationEmails();

    expect(resendHolder.sent.flat().map((m: any) => m.to)).toEqual([
      "live@acme.com",
    ]);
    expect(result.sent).toBe(1);
    // Recorded as failed with a reason a human can act on — not retried, since
    // nothing will change until someone clears the suppression.
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    const failedUpdate = mock.calls.set.find((s: any) => s.status === "failed");
    expect(String(failedUpdate.lastError)).toMatch(/suppress/i);
  });

  it("matches a suppression regardless of address casing", async () => {
    setupQueue(
      [row({ id: "q1", recipient_id: "uid-a", email: "Dead@Acme.com" })],
      0,
      ["dead@acme.com"],
    );

    const result = await processNotificationEmails();

    expect(resendHolder.sent).toEqual([]);
    expect(result.sent).toBe(0);
  });

  it("reports work still due so the route can chain another run", async () => {
    setupQueue([row()], 42);
    const result = await processNotificationEmails();
    expect(result.remaining).toBe(42);
  });

  it("returns early on an empty queue", async () => {
    setupQueue([], 0);
    const result = await processNotificationEmails();
    expect(result).toMatchObject({ processed: 0, sent: 0, remaining: 0 });
    expect(resendHolder.sent).toHaveLength(0);
  });
});
