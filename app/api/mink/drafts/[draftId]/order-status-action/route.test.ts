import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  emit: vi.fn(),
  revalidatePath: vi.fn(),
  rateAllowed: true,
}));

vi.mock("next/cache", () => ({ revalidatePath: holder.revalidatePath }));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: true })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/order-status-actions", () => ({
  previewMinkOrderStatusAction: holder.preview,
  executeMinkOrderStatusAction: holder.execute,
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
const EXECUTION = {
  approval: {
    id: APPROVAL_ID,
    draftId: DRAFT_ID,
    operation: "apply",
    toolName: "transition_order_status",
    resource: {
      type: "order",
      id: "order-1",
      label: "ORD-1001",
      dashboardPath: "/dashboard/orders?q=ORD-1001",
    },
    before: { status: "pending" },
    after: { status: "processing" },
  },
  auditId: "audit-1",
  repeated: false,
  eventCustomerId: "customer-1",
};

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
  holder.execute.mockResolvedValue(EXECUTION);
});

describe("Mink Phase 5C order-status action API", () => {
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

  it("previews only a saved server-side draft version", async () => {
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 2,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.preview).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      draftId: DRAFT_ID,
      expectedDraftVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("rejects browser-supplied order fields before authentication", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        orderId: "attacker-order",
        status: "delivered",
        customerId: "attacker-customer",
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.execute).not.toHaveBeenCalled();
  });

  it("enforces the streamed body limit", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        padding: "x".repeat(5_000),
      }),
      PARAMS,
    );
    expect(response.status).toBe(413);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("executes by approval id and emits one customer-scoped event", async () => {
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.status_changed",
        storeId: "store-1",
        customerId: "customer-1",
        payload: expect.objectContaining({
          status: "processing",
          approvalId: APPROVAL_ID,
        }),
      }),
    );
    const payload = await response.json();
    expect(payload.result.eventCustomerId).toBeUndefined();
  });

  it("does not emit again for an idempotent replay", async () => {
    holder.execute.mockResolvedValueOnce({
      ...EXECUTION,
      repeated: true,
      eventCustomerId: null,
    });
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.emit).not.toHaveBeenCalled();
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/order-status-action`,
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
