import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  emit: vi.fn(),
  report: vi.fn(),
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
vi.mock("@/lib/mink/inventory-actions", () => ({
  previewMinkInventoryAction: holder.preview,
  executeMinkInventoryAction: holder.execute,
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: holder.emit }));
vi.mock("@/lib/inventory/alerts", () => ({
  reportStockChanges: holder.report,
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
const PARAMS = { params: Promise.resolve({ draftId: DRAFT_ID }) };
const EXECUTED_RESULT = {
  approval: {
    id: APPROVAL_ID,
    draftId: DRAFT_ID,
    operation: "apply",
    toolName: "adjust_inventory",
    resource: {
      type: "inventory",
      id: "product-1",
      productId: "product-1",
      variantId: "variant-1",
      locationId: "location-1",
      label: "Tea · 500 g (TEA-500) at Delhi",
      dashboardPath: "/dashboard/inventory?location=location-1",
    },
    before: { on_hand: "9" },
    after: {
      quantity_change: "3",
      resulting_on_hand: "12",
      reason: "received",
    },
  },
  auditId: "audit-1",
  repeated: false,
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
  holder.execute.mockResolvedValue(EXECUTED_RESULT);
});

describe("Mink Phase 5A inventory action API", () => {
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

  it("rejects browser-supplied inventory fields before authentication", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        productId: "attacker-product",
        locationId: "attacker-location",
        quantity: 999,
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.execute).not.toHaveBeenCalled();
  });

  it("enforces the body limit from streamed bytes even without trusting a header", async () => {
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

  it("executes by approval id, emits one scoped event and reports stock once", async () => {
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
    expect(holder.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "inventory.adjusted",
        storeId: "store-1",
        locationId: "location-1",
        payload: expect.objectContaining({ approvalId: APPROVAL_ID, delta: 3 }),
      }),
    );
    expect(holder.report).toHaveBeenCalledWith("store-1", [
      { productId: "product-1", variantId: "variant-1", delta: 3 },
    ]);
    expect(holder.revalidateTag).toHaveBeenCalledWith(
      "storefront:products",
      "max",
    );
  });

  it("does not emit duplicate effects when execution is an idempotent replay", async () => {
    holder.execute.mockResolvedValueOnce({
      ...EXECUTED_RESULT,
      repeated: true,
    });
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.emit).not.toHaveBeenCalled();
    expect(holder.report).not.toHaveBeenCalled();
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/inventory-action`,
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
