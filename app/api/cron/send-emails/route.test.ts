/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `after` is the self-chaining hook; keep the real NextResponse.
const afterCalls = vi.hoisted(() => ({ fns: [] as (() => unknown)[] }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => unknown) => {
      afterCalls.fns.push(fn);
    }),
  };
});
vi.mock("@/lib/email/campaign-worker", () => ({ processEmailQueue: vi.fn() }));
vi.mock("@/lib/email/notification-worker", () => ({
  processNotificationEmails: vi.fn(),
}));
vi.mock("@/lib/email/trigger-worker", () => ({ triggerEmailWorker: vi.fn() }));
vi.mock("@/lib/sms/worker", () => ({ runSmsWorker: vi.fn() }));

import { GET, POST } from "./route";
import { processEmailQueue } from "@/lib/email/campaign-worker";
import { processNotificationEmails } from "@/lib/email/notification-worker";
import { runSmsWorker } from "@/lib/sms/worker";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";

function req(auth?: string): Request {
  return new Request("https://storemink.com/api/cron/send-emails", {
    headers: auth ? { authorization: auth } : {},
  });
}

// Drains all THREE outbound queues (coupon campaigns, notification emails and
// SMS — the last rides the same heartbeat rather than getting its own job).
// Auth is `Authorization: Bearer <CRON_SECRET>`; without the secret set the
// route must refuse rather than run unauthenticated.
describe("/api/cron/send-emails", () => {
  const OLD_ENV = process.env.CRON_SECRET;

  beforeEach(() => {
    // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
    vi.mocked(runSmsWorker).mockResolvedValue({
      claimed: 0,
      sent: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
    });
    vi.clearAllMocks();
    afterCalls.fns = [];
    process.env.CRON_SECRET = "s3cret";
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 0,
      remaining: 0,
    } as any);
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 0,
      remaining: 0,
    } as any);
  });

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = OLD_ENV;
  });

  it("refuses a request with no Authorization header", async () => {
    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(processEmailQueue).not.toHaveBeenCalled();
    expect(processNotificationEmails).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    const res = await GET(req("Bearer wrong"));

    expect(res.status).toBe(401);
    expect(processEmailQueue).not.toHaveBeenCalled();
  });

  it("refuses a bare secret without the Bearer scheme", async () => {
    const res = await GET(req("s3cret"));

    expect(res.status).toBe(401);
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    // Fails CLOSED: an unset secret must not mean "let anyone drain the queue",
    // which is what comparing against undefined would allow.
    delete process.env.CRON_SECRET;

    expect((await GET(req("Bearer undefined"))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(processEmailQueue).not.toHaveBeenCalled();
  });

  it("drains all three queues on a valid secret", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 5,
      remaining: 0,
    } as any);
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 2,
      remaining: 0,
    } as any);

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      campaigns: { sent: 5, remaining: 0 },
      notifications: { sent: 2, remaining: 0 },
      // SMS rides the same heartbeat rather than getting its own schedule —
      // one more Cloud Scheduler entry is one more thing to forget, which
      // docs/cron-jobs.md records happening three times already.
      sms: { claimed: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 },
    });
  });

  // ★ It must not be able to take the email queues down with it. SMS goes
  // through a different provider entirely, so a Twilio outage has no business
  // stopping a merchant's order confirmations.
  it("still reports the email queues when the SMS worker throws", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 5,
      remaining: 0,
    } as any);
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 2,
      remaining: 0,
    } as any);
    vi.mocked(runSmsWorker).mockRejectedValue(new Error("twilio down"));

    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaigns).toEqual({ sent: 5, remaining: 0 });
    expect(body.sms).toBeNull();
  });

  it("runs the workers sequentially, campaigns first", async () => {
    // They share a Resend account and claim from the same pool, so overlapping
    // them buys nothing and makes rate limits harder to reason about.
    const order: string[] = [];
    vi.mocked(processEmailQueue).mockImplementation(async () => {
      order.push("campaigns");
      return { sent: 0, remaining: 0 } as any;
    });
    vi.mocked(processNotificationEmails).mockImplementation(async () => {
      order.push("notifications");
      return { sent: 0, remaining: 0 } as any;
    });

    await GET(req("Bearer s3cret"));

    expect(order).toEqual(["campaigns", "notifications"]);
  });

  it("does not chain another run when both queues are drained", async () => {
    await GET(req("Bearer s3cret"));

    expect(afterCalls.fns).toHaveLength(0);
  });

  it("chains another run when campaigns have work left", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 100,
      remaining: 40,
    } as any);

    await GET(req("Bearer s3cret"));

    expect(afterCalls.fns).toHaveLength(1);
  });

  it("chains another run when notifications have work left", async () => {
    vi.mocked(processNotificationEmails).mockResolvedValue({
      sent: 100,
      remaining: 7,
    } as any);

    await GET(req("Bearer s3cret"));

    expect(afterCalls.fns).toHaveLength(1);
  });

  it("chains via triggerEmailWorker, after the response is sent", async () => {
    vi.mocked(processEmailQueue).mockResolvedValue({
      sent: 1,
      remaining: 1,
    } as any);

    await GET(req("Bearer s3cret"));
    // Deferred, not awaited inline — a large campaign must not sit on the
    // response.
    expect(triggerEmailWorker).not.toHaveBeenCalled();
    afterCalls.fns[0]();
    expect(triggerEmailWorker).toHaveBeenCalled();
  });

  it("serves POST identically to GET", async () => {
    const res = await POST(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("refuses an unauthorized POST too", async () => {
    expect((await POST(req("Bearer nope"))).status).toBe(401);
  });
});
