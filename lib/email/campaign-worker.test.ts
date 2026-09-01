/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/email/coupon-campaign", () => ({
  mergeTokens: (t: string) => t,
  renderCouponEmail: () => "<html>",
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrandById: vi.fn(async () => ({
    name: "WholeSip",
    domain: "wholesip.com",
  })),
}));

const { batchSend, emailSend } = vi.hoisted(() => ({
  batchSend: vi.fn(),
  emailSend: vi.fn(),
}));
vi.mock("resend", () => {
  class Resend {
    batch = { send: batchSend };
    emails = { send: emailSend };
    constructor() {}
  }
  return { Resend };
});

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { processEmailQueue } from "./campaign-worker";
import { getStoreBrandById } from "@/lib/store/brand";

const campaign = {
  id: "camp1",
  subject: "Hi {{first_name}}",
  body: "B",
  code: "C",
  discount_label: "10% off",
  valid_until_label: null,
  store_id: "store-1",
};

// executeQueue: #1 requeue (ignored) → #2 claim_email_batch (the batch) →
// #3 claim again (empty, so the drain loop terminates).
// selectQueue: #1 = the email_campaigns lookup for the batch.
function wire(
  batch: Array<Record<string, unknown>>,
  suppressed: string[] = [],
  campaignRow: Record<string, unknown> = campaign,
) {
  dbHolder.current = makeDbMock({
    // #1 the email_campaigns lookup, #2 the suppression lookup.
    selectQueue: [[campaignRow], suppressed.map((email) => ({ email }))],
    executeQueue: [[], batch, []],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  batchSend.mockResolvedValue({ data: { data: [{ id: "1" }] }, error: null });
  emailSend.mockResolvedValue({ data: { id: "1" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("processEmailQueue", () => {
  it("does nothing (and touches no DB) when RESEND_API_KEY is absent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    dbHolder.current = makeDbMock();
    const result = await processEmailQueue();
    expect(result).toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
      remaining: 0,
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("sends a claimed batch, marks it sent, and reports counts", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_realkey");
    wire([
      { id: "r1", campaign_id: "camp1", email: "a@x.com", first_name: "Ada" },
      { id: "r2", campaign_id: "camp1", email: "b@x.com", first_name: "Bob" },
    ]);

    const result = await processEmailQueue();

    expect(batchSend).toHaveBeenCalledTimes(1);
    expect(batchSend.mock.calls[0][0]).toHaveLength(2);
    expect(result).toMatchObject({ processed: 2, sent: 2, failed: 0 });
    expect(result.remaining).toBe(0);
    // The attempted rows are marked sent.
    expect(dbHolder.current.calls.set).toContainEqual({ status: "sent" });
  });

  it("marks a batch failed when Resend errors", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_realkey");
    batchSend.mockResolvedValue({ data: null, error: { message: "nope" } });
    wire([
      { id: "r1", campaign_id: "camp1", email: "a@x.com", first_name: "Ada" },
    ]);

    const result = await processEmailQueue();

    expect(result).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(dbHolder.current.calls.set).toContainEqual({ status: "failed" });
  });

  // REGRESSION. A campaign list is customer-entered data, so a bad address in
  // it is inevitable — and this worker has NO retry, so an all-or-nothing batch
  // verdict wrote off every other recipient in that batch permanently. Their
  // coupon email simply never arrived and nothing said so.
  it("delivers the rest of a campaign batch when one address is bad", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_realkey");
    batchSend.mockResolvedValue({
      data: null,
      error: { message: "invalid to" },
    });
    emailSend.mockImplementation(async (message: any) =>
      message.to === "broken@@x.com"
        ? { data: null, error: { message: "invalid to" } }
        : { data: { id: "1" }, error: null },
    );
    wire([
      { id: "r1", campaign_id: "camp1", email: "a@x.com", first_name: "Ada" },
      {
        id: "r2",
        campaign_id: "camp1",
        email: "broken@@x.com",
        first_name: "Bob",
      },
      { id: "r3", campaign_id: "camp1", email: "c@x.com", first_name: "Cy" },
    ]);

    const result = await processEmailQueue();

    expect(result).toMatchObject({ processed: 3, sent: 2, failed: 1 });
    expect(dbHolder.current.calls.set).toContainEqual({ status: "sent" });
    expect(dbHolder.current.calls.set).toContainEqual({ status: "failed" });
  });

  // A marketing blast is where mailing dead addresses hurts most: it's the
  // shared sending domain's reputation being spent on mail nobody receives.
  it("skips addresses a permanent bounce has taken out of service", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_realkey");
    wire(
      [
        {
          id: "r1",
          campaign_id: "camp1",
          email: "live@x.com",
          first_name: "A",
        },
        {
          id: "r2",
          campaign_id: "camp1",
          email: "dead@x.com",
          first_name: "B",
        },
      ],
      ["dead@x.com"],
    );

    const result = await processEmailQueue();

    expect(batchSend).toHaveBeenCalledTimes(1);
    expect(batchSend.mock.calls[0][0].map((m: any) => m.to)).toEqual([
      "live@x.com",
    ]);
    expect(result).toMatchObject({ processed: 2, sent: 1, failed: 1 });
  });

  it("uses the exact sender and brand snapshotted by a Mink approval", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_realkey");
    wire(
      [{ id: "r1", campaign_id: "camp1", email: "a@x.com", first_name: "A" }],
      [],
      {
        ...campaign,
        sender_address: "Approved Store <hello@approved.example>",
        brand_snapshot: {
          name: "Approved Store",
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
          domain: "approved.example",
        },
      },
    );

    await processEmailQueue();

    expect(batchSend.mock.calls[0][0][0].from).toBe(
      "Approved Store <hello@approved.example>",
    );
    expect(getStoreBrandById).not.toHaveBeenCalled();
  });
});
