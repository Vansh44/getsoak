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
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

const suppressed = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@/lib/email/suppression", () => ({
  findSuppressed: vi.fn(async () => new Set(suppressed.list)),
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));

const resendHolder = vi.hoisted(() => ({
  calls: [] as any[],
  error: null as { message: string } | null,
  throws: false,
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (message: any) => {
        if (resendHolder.throws) throw new Error("socket hang up");
        resendHolder.calls.push(message);
        return resendHolder.error
          ? { data: null, error: resendHolder.error }
          : { data: { id: "msg_1" }, error: null };
      },
    };
  },
}));

import { sendEmail, emailConfigured } from "./send";
import { REDACTED } from "./mailers";

/** The values handed to the email_logs insert on the last write. */
function loggedRow(): any {
  return dbHolder.current.calls.values.at(-1);
}

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resendHolder.calls = [];
    resendHolder.error = null;
    resendHolder.throws = false;
    suppressed.list = [];
    dbHolder.current = makeDbMock();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = {
    storeId: "store-1",
    to: "shopper@example.com",
    from: "Acme <admin@acme.com>",
    subject: "Your order is confirmed",
    html: "<p>Thanks!</p>",
    mailer: "notification" as const,
  };

  it("sends and records the message", async () => {
    const result = await sendEmail(base);

    expect(result.sent).toBe(true);
    expect(resendHolder.calls).toHaveLength(1);
    expect(loggedRow()).toMatchObject({
      storeId: "store-1",
      toEmail: "shopper@example.com",
      status: "sent",
      mailer: "notification",
      providerMessageId: "msg_1",
      bodyHtml: "<p>Thanks!</p>",
    });
  });

  // The failed sends are the rows anyone actually opens this log to find.
  it("records a rejected send rather than dropping it", async () => {
    resendHolder.error = { message: "Invalid recipient" };

    const result = await sendEmail(base);

    expect(result.sent).toBe(false);
    expect(loggedRow()).toMatchObject({
      status: "failed",
      error: "Invalid recipient",
    });
  });

  it("records a send that threw, and never rethrows", async () => {
    resendHolder.throws = true;

    await expect(sendEmail(base)).resolves.toMatchObject({ sent: false });
    expect(loggedRow()).toMatchObject({
      status: "failed",
      error: "socket hang up",
    });
  });

  it("records — but does not attempt — a suppressed address", async () => {
    suppressed.list = ["shopper@example.com"];

    const result = await sendEmail(base);

    expect(result.sent).toBe(false);
    expect(resendHolder.calls).toHaveLength(0);
    expect(loggedRow()).toMatchObject({ status: "skipped" });
  });

  it("still sends to a suppressed address when told to ignore it", async () => {
    // Someone waiting on a sign-in code must not be locked out by an old bounce.
    suppressed.list = ["shopper@example.com"];

    const result = await sendEmail({ ...base, ignoreSuppression: true });

    expect(result.sent).toBe(true);
    expect(resendHolder.calls).toHaveLength(1);
  });

  it("logs the intent when email isn't configured, instead of claiming success", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    const result = await sendEmail(base);

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(true);
    expect(loggedRow()).toMatchObject({ status: "skipped" });
  });

  // THE SECURITY RULE. A staff invite carries a working temporary password in
  // plaintext; storing it verbatim would put a live credential in a table store
  // staff can read, long after anyone needed it.
  it("redacts the subject AND body of a credential-carrying email", async () => {
    await sendEmail({
      ...base,
      subject: "Welcome to Acme Dashboard",
      html: "<p>Password: hunter2</p>",
      mailer: "staff_invite",
    });

    const row = loggedRow();
    expect(row.subject).toBe(REDACTED);
    expect(row.bodyHtml).toBeNull();
    // The delivery facts — which are what a log is for — all survive.
    expect(row).toMatchObject({
      toEmail: "shopper@example.com",
      mailer: "staff_invite",
      status: "sent",
    });
    // And the real email still went out with the real credential in it.
    expect(resendHolder.calls[0].html).toContain("hunter2");
  });

  // Owner's explicit decision: operator sign-in codes are stored in full, so a
  // code that "never arrived" can be checked against the log. Asserted rather
  // than assumed, because it's the opposite of the rule above.
  it("stores an operator sign-in code in full, by decision", async () => {
    await sendEmail({
      ...base,
      storeId: null,
      subject: "483920 is your StoreMink sign-in code",
      html: "<p>483920</p>",
      mailer: "operator_otp",
    });

    const row = loggedRow();
    expect(row.subject).toContain("483920");
    expect(row.bodyHtml).toContain("483920");
    // Platform mail: store_id stays null, so no merchant's log can show it.
    expect(row.storeId).toBeNull();
  });

  it("keeps oversized bodies out of the log but still records the send", async () => {
    await sendEmail({ ...base, html: "x".repeat(300_000) });

    expect(loggedRow()).toMatchObject({ status: "sent", bodyHtml: null });
  });

  it("never lets a log-write failure look like a failed send", async () => {
    dbHolder.current = makeDbMock({ failInsertFor: undefined });
    dbHolder.current.db.insert = () => {
      throw new Error("email_logs is gone");
    };

    await expect(sendEmail(base)).resolves.toMatchObject({ sent: true });
  });
});

describe("emailConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is false without a key, or with a placeholder", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(emailConfigured()).toBe(false);
    vi.stubEnv("RESEND_API_KEY", "re_placeholder_key");
    expect(emailConfigured()).toBe(false);
  });

  it("is true for a real key", () => {
    vi.stubEnv("RESEND_API_KEY", "re_live_abc");
    expect(emailConfigured()).toBe(true);
  });
});
