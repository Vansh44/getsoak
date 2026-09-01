import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  options: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  trigger: vi.fn(),
  rateAllowed: true,
}));

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: (callback: () => unknown) => callback() };
});
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: true })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/campaign-actions", () => ({
  getMinkCampaignAudienceOptions: holder.options,
  previewMinkCampaign: holder.preview,
  executeMinkCampaign: holder.execute,
}));
vi.mock("@/lib/email/trigger-worker", () => ({
  triggerEmailWorker: holder.trigger,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const GROUP_ID = "44444444-4444-4444-8444-444444444444";
const PARAMS = { params: Promise.resolve({ draftId: DRAFT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  holder.rateAllowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    email: "owner@example.com",
    draftingEnabled: true,
  });
  holder.options.mockResolvedValue({ allLabel: "All customers", groups: [] });
  holder.preview.mockResolvedValue({ id: APPROVAL_ID });
  holder.execute.mockResolvedValue({
    approval: { id: APPROVAL_ID },
    auditId: "audit-1",
    repeated: false,
    campaign: {
      id: "campaign-1",
      status: "pending",
      scheduledFor: null,
      recipientCount: 12,
    },
    triggerWorker: true,
  });
});

describe("Mink Phase 5E campaign API", () => {
  it("rejects cross-origin requests before authentication", async () => {
    const response = await POST(
      request({ action: "options" }, "https://attacker.example"),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("loads server-owned audience options", async () => {
    const response = await POST(request({ action: "options" }), PARAMS);
    expect(response.status).toBe(200);
    expect(holder.options).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1" }),
      DRAFT_ID,
    );
  });

  it("previews an exact group and UTC schedule", async () => {
    const scheduledFor = "2026-09-02T06:30:00.000Z";
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 2,
        idempotencyKey: IDEMPOTENCY_KEY,
        audienceMode: "group",
        groupId: GROUP_ID,
        mode: "schedule",
        scheduledFor,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.preview).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      draftId: DRAFT_ID,
      expectedDraftVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
      audienceMode: "group",
      groupId: GROUP_ID,
      mode: "schedule",
      scheduledFor,
    });
  });

  it("rejects browser-supplied recipients, copy and tenant ids pre-auth", async () => {
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 2,
        idempotencyKey: IDEMPOTENCY_KEY,
        audienceMode: "all",
        mode: "send_now",
        recipients: ["victim@example.com"],
        subject: "Injected",
        storeId: "attacker-store",
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.preview).not.toHaveBeenCalled();
  });

  it("executes by approval id and kicks only an immediate first execution", async () => {
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.trigger).toHaveBeenCalledTimes(1);
    const payload = await response.json();
    expect(payload.result.triggerWorker).toBeUndefined();

    holder.execute.mockResolvedValueOnce({
      ...(await holder.execute.mock.results[0].value),
      repeated: true,
      triggerWorker: false,
    });
    await POST(request({ action: "execute", approvalId: APPROVAL_ID }), PARAMS);
    expect(holder.trigger).toHaveBeenCalledTimes(1);
  });

  it("does not kick the worker for a scheduled campaign", async () => {
    holder.execute.mockResolvedValueOnce({
      approval: { id: APPROVAL_ID },
      auditId: "audit-1",
      repeated: false,
      campaign: {
        id: "campaign-1",
        status: "scheduled",
        scheduledFor: "2026-09-02T06:30:00.000Z",
        recipientCount: 12,
      },
      triggerWorker: false,
    });
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.trigger).not.toHaveBeenCalled();
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/campaign-action`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        host: "acme.storemink.com",
      },
      body: JSON.stringify(body),
    },
  );
}
