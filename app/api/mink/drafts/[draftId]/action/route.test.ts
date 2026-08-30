import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  rollback: vi.fn(),
  emit: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  rateAllowed: true,
}));

vi.mock("next/cache", () => ({
  revalidatePath: holder.revalidatePath,
  revalidateTag: holder.revalidateTag,
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: true })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/domain-actions", () => ({
  previewMinkDomainAction: holder.preview,
  executeMinkDomainAction: holder.execute,
  previewMinkDomainActionRollback: holder.rollback,
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: holder.emit }));
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
  holder.preview.mockResolvedValue({ id: APPROVAL_ID, draftId: DRAFT_ID });
  holder.rollback.mockResolvedValue({ id: APPROVAL_ID, draftId: DRAFT_ID });
  holder.execute.mockResolvedValue({
    approval: {
      id: APPROVAL_ID,
      draftId: DRAFT_ID,
      operation: "apply",
      toolName: "create_coupon",
      resource: {
        type: "coupon",
        id: "coupon-1",
        label: "Coupon SAVE10",
        dashboardPath: "/dashboard/marketing/coupons/coupon-1/edit",
      },
    },
    auditId: "audit-1",
    repeated: false,
  });
});

describe("Mink Phase 4B-4D action API", () => {
  it("rejects cross-origin requests before authentication", async () => {
    const response = await POST(
      request(
        {
          action: "preview",
          expectedDraftVersion: 1,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        "https://attacker.example",
      ),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("previews only the saved server-side proposal version", async () => {
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 4,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.preview).toHaveBeenCalledWith({
      actor: expect.objectContaining({
        storeId: "store-1",
        adminId: "admin-1",
      }),
      draftId: DRAFT_ID,
      expectedDraftVersion: 4,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("refuses browser-supplied business fields at execution", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        status: "active",
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.execute).not.toHaveBeenCalled();
  });

  it("executes by approval id and invalidates only the relevant domain", async () => {
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.execute).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });
    expect(holder.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/marketing/coupons/coupon-1/edit",
    );
    expect(holder.revalidateTag).toHaveBeenCalledWith(
      "storefront:coupons",
      "max",
    );
    expect(holder.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "coupon.created",
        storeId: "store-1",
        payload: expect.objectContaining({ approvalId: APPROVAL_ID }),
      }),
    );
  });

  it("creates rollback previews from a completed approval id only", async () => {
    const response = await POST(
      request({
        action: "preview_rollback",
        sourceApprovalId: APPROVAL_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.rollback).toHaveBeenCalledWith({
      actor: expect.objectContaining({ adminId: "admin-1" }),
      draftId: DRAFT_ID,
      sourceApprovalId: APPROVAL_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/action`,
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
