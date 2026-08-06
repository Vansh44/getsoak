/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/email/webhook-signature", () => ({
  verifySvixSignature: vi.fn(),
}));
vi.mock("@/lib/email/suppression", () => ({ suppressEmail: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { POST } from "./route";
import { verifySvixSignature } from "@/lib/email/webhook-signature";
import { suppressEmail } from "@/lib/email/suppression";
import { logError, logWarn } from "@/lib/observability/logger";

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://storemink.com/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": "1700000000",
      "svix-signature": "v1,sig",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const bounced = (subType: string, to: any = ["dead@example.com"]) => ({
  type: "email.bounced",
  data: { to, bounce: { subType, message: `bounce: ${subType}` } },
});

// Resend delivery webhooks — the missing half of "did the mail arrive?" (§24).
// This endpoint decides whether we STOP mailing an address, so unsigned, anyone
// could suppress a store's entire customer list.
describe("POST /api/webhooks/resend", () => {
  const OLD = process.env.RESEND_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    vi.mocked(verifySvixSignature).mockReturnValue({ ok: true } as any);
    vi.mocked(suppressEmail).mockResolvedValue(true as any);
  });

  afterEach(() => {
    if (OLD === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = OLD;
  });

  it("ignores deliveries when the signing secret is unconfigured", async () => {
    // Deliberately NOT an error worth retrying — but it must never accept
    // unverified payloads instead.
    delete process.env.RESEND_WEBHOOK_SECRET;

    const res = await POST(req(bounced("permanent")));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "not configured" });
    expect(verifySvixSignature).not.toHaveBeenCalled();
    expect(suppressEmail).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it("rejects an unsigned or forged payload", async () => {
    vi.mocked(verifySvixSignature).mockReturnValue({
      ok: false,
      reason: "signature mismatch",
    } as any);

    const res = await POST(req(bounced("permanent")));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid signature" });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("verifies against the RAW body, not a re-serialised one", async () => {
    // Parsing and re-serialising changes the bytes and the signature would
    // never match.
    const raw = '{"type":"email.bounced","data":{"to":["a@b.c"]}}';

    await POST(req(raw));

    expect(verifySvixSignature).toHaveBeenCalledWith(
      "whsec_test",
      { id: "msg_1", timestamp: "1700000000", signature: "v1,sig" },
      raw,
    );
  });

  it("passes null svix headers through to the verifier rather than skipping it", async () => {
    vi.mocked(verifySvixSignature).mockReturnValue({
      ok: false,
      reason: "missing headers",
    } as any);
    const r = new Request("https://storemink.com/api/webhooks/resend", {
      method: "POST",
      body: "{}",
    });

    const res = await POST(r);

    expect(res.status).toBe(401);
    expect(verifySvixSignature).toHaveBeenCalledWith(
      "whsec_test",
      { id: null, timestamp: null, signature: null },
      "{}",
    );
  });

  it("accepts a signed but unparseable body without asking for redelivery", async () => {
    // Signed and malformed will never parse — 200 so Resend stops retrying
    // something no redelivery can fix.
    const res = await POST(req("not json{{"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "bad payload" });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("suppresses a permanent bounce", async () => {
    const res = await POST(req(bounced("permanent")));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suppressed: 1 });
    expect(suppressEmail).toHaveBeenCalledWith({
      email: "dead@example.com",
      reason: "bounce",
      detail: "bounce: permanent",
    });
  });

  it.each(["permanent", "hard", "suppressed", "block", "HARD", "Permanent"])(
    "treats %s as a permanent bounce, case-insensitively",
    async (sub) => {
      await POST(req(bounced(sub)));

      expect(suppressEmail).toHaveBeenCalled();
    },
  );

  it("does NOT suppress a soft bounce", async () => {
    // A full mailbox resolves itself and is already covered by the queue's
    // retry/backoff — cutting a real customer off over one is worse.
    const res = await POST(req(bounced("transient")));

    expect(await res.json()).toEqual({ ok: true, suppressed: 0, soft: true });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("treats an UNKNOWN bounce sub-type as soft", async () => {
    // Guessing wrong costs a customer every future email.
    const res = await POST(req(bounced("some-new-resend-subtype")));

    expect(await res.json()).toMatchObject({ soft: true, suppressed: 0 });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("treats a bounce with no sub-type at all as soft", async () => {
    const res = await POST(
      req({ type: "email.bounced", data: { to: ["a@b.c"], bounce: {} } }),
    );

    expect(await res.json()).toMatchObject({ soft: true });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("falls back to bounce.type when subType is absent", async () => {
    const res = await POST(
      req({
        type: "email.bounced",
        data: { to: ["a@b.c"], bounce: { type: "hard" } },
      }),
    );

    expect(await res.json()).toEqual({ ok: true, suppressed: 1 });
    expect(suppressEmail).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bounce", detail: "hard" }),
    );
  });

  it("uses the sub-type as the detail when the bounce carries no message", async () => {
    await POST(
      req({
        type: "email.bounced",
        data: { to: ["a@b.c"], bounce: { subType: "permanent" } },
      }),
    );

    expect(suppressEmail).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "permanent" }),
    );
  });

  it("always suppresses a spam complaint", async () => {
    // The strongest possible "stop" — never soft.
    const res = await POST(
      req({ type: "email.complained", data: { to: ["angry@example.com"] } }),
    );

    expect(await res.json()).toEqual({ ok: true, suppressed: 1 });
    expect(suppressEmail).toHaveBeenCalledWith({
      email: "angry@example.com",
      reason: "complaint",
      detail: "Marked as spam",
    });
  });

  it("handles a single string recipient as well as an array", async () => {
    await POST(
      req({ type: "email.complained", data: { to: "solo@example.com" } }),
    );

    expect(suppressEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "solo@example.com" }),
    );
  });

  it("suppresses every recipient of a multi-address bounce", async () => {
    const res = await POST(
      req(bounced("permanent", ["a@x.com", "b@x.com", "c@x.com"])),
    );

    expect(await res.json()).toEqual({ ok: true, suppressed: 3 });
    expect(suppressEmail).toHaveBeenCalledTimes(3);
  });

  it("counts only the addresses actually newly suppressed", async () => {
    // suppressEmail returns false for an address already on the list; counting
    // it would overstate what this delivery did.
    vi.mocked(suppressEmail)
      .mockResolvedValueOnce(true as any)
      .mockResolvedValueOnce(false as any);

    const res = await POST(
      req(bounced("permanent", ["new@x.com", "old@x.com"])),
    );

    expect(await res.json()).toEqual({ ok: true, suppressed: 1 });
  });

  it("drops empty recipient entries", async () => {
    const res = await POST(
      req(bounced("permanent", ["good@x.com", "", null as any])),
    );

    expect(await res.json()).toEqual({ ok: true, suppressed: 1 });
    expect(suppressEmail).toHaveBeenCalledTimes(1);
  });

  it("accepts a delivery with no recipients without doing anything", async () => {
    const res = await POST(req({ type: "email.bounced", data: { to: [] } }));

    expect(await res.json()).toEqual({ ok: true, suppressed: 0 });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("accepts a delivery with no data at all", async () => {
    const res = await POST(req({ type: "email.bounced" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, suppressed: 0 });
  });

  it("ignores event types it does not act on", async () => {
    // email.sent / email.delivered arrive on the same endpoint.
    const res = await POST(
      req({ type: "email.delivered", data: { to: ["a@b.c"] } }),
    );

    expect(await res.json()).toEqual({ ok: true, suppressed: 0 });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("ignores a payload with no type", async () => {
    const res = await POST(req({ data: { to: ["a@b.c"] } }));

    expect(await res.json()).toEqual({ ok: true, suppressed: 0 });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it("asks for redelivery when suppression itself fails", async () => {
    // Losing a bounce means mailing a dead address forever, so this is the one
    // failure that must 500.
    vi.mocked(suppressEmail).mockRejectedValue(new Error("db down"));

    const res = await POST(req(bounced("permanent")));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "processing failed" });
    expect(logError).toHaveBeenCalledWith(
      "resend webhook: processing failed",
      expect.anything(),
      { type: "email.bounced" },
    );
  });

  it("asks for redelivery when a complaint fails to record", async () => {
    vi.mocked(suppressEmail).mockRejectedValue(new Error("db down"));

    const res = await POST(
      req({ type: "email.complained", data: { to: ["a@b.c"] } }),
    );

    expect(res.status).toBe(500);
  });
});
