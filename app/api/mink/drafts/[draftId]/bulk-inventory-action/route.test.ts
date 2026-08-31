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
vi.mock("@/lib/mink/bulk-inventory-actions", async () => {
  const { MinkRequestError } = await import("@/lib/mink/errors");
  return {
    MinkBulkInventoryValidationError: class extends MinkRequestError {
      constructor(
        message: string,
        public readonly lineErrors: unknown[],
      ) {
        super("mink_bulk_inventory_lines_invalid", message, 409);
      }
    },
    previewMinkBulkInventoryAction: holder.preview,
    executeMinkBulkInventoryAction: holder.execute,
  };
});
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
    toolName: "bulk_adjust_inventory",
    resource: {
      type: "inventory_bulk",
      label: "2 inventory adjustments",
      dashboardPath: "/dashboard/inventory",
      lineCount: 2,
    },
    lines: [
      {
        line: 1,
        productId: "product-1",
        variantId: "variant-1",
        locationId: "location-1",
        product: "Tea",
        variant: "500 g",
        sku: "TEA-500",
        location: "Delhi",
        quantityChange: 3,
        resultingOnHand: 12,
        reason: "received",
      },
      {
        line: 2,
        productId: "product-2",
        variantId: null,
        locationId: "location-2",
        product: "Coffee",
        variant: null,
        sku: "COFFEE",
        location: "Shop",
        quantityChange: -2,
        resultingOnHand: 8,
        reason: "correction",
      },
    ],
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

describe("Mink Phase 5B bulk inventory action API", () => {
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
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.preview).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      draftId: DRAFT_ID,
      expectedDraftVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("rejects browser-supplied business fields before authentication", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        lines: [{ sku: "ATTACK", quantity: 999 }],
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.execute).not.toHaveBeenCalled();
  });

  it("enforces the body limit from streamed bytes", async () => {
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

  it("returns bounded line-level corrections without exposing internals", async () => {
    const { MinkBulkInventoryValidationError } =
      await import("@/lib/mink/bulk-inventory-actions");
    holder.preview.mockRejectedValueOnce(
      new MinkBulkInventoryValidationError("Two lines need correction.", [
        {
          line: 1,
          sku: "MISSING",
          location: "Delhi",
          code: "sku_not_found",
          message: "The exact SKU was not found in this store.",
        },
        {
          line: 2,
          sku: "TEA-500",
          location: "Hidden warehouse",
          code: "location_unavailable",
          message: "The location is unavailable.",
        },
      ]),
    );
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      PARAMS,
    );
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toEqual({
      error: "Two lines need correction.",
      code: "mink_bulk_inventory_lines_invalid",
      lineErrors: expect.arrayContaining([
        expect.objectContaining({ line: 1, code: "sku_not_found" }),
        expect.objectContaining({ line: 2, code: "location_unavailable" }),
      ]),
    });
  });

  it("rate-limits the trusted actor and store before domain execution", async () => {
    holder.rateAllowed = false;
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(429);
    expect(holder.execute).not.toHaveBeenCalled();
  });

  it("emits bounded line events and reports one combined stock change set", async () => {
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.emit).toHaveBeenCalledTimes(2);
    expect(holder.emit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "inventory.adjusted",
        storeId: "store-1",
        locationId: "location-1",
        payload: expect.objectContaining({
          source: "mink_ai_bulk",
          approvalId: APPROVAL_ID,
          line: 1,
          delta: 3,
        }),
      }),
    );
    expect(holder.report).toHaveBeenCalledWith("store-1", [
      { productId: "product-1", variantId: "variant-1", delta: 3 },
      { productId: "product-2", variantId: null, delta: -2 },
    ]);
    expect(holder.revalidateTag).toHaveBeenCalledWith(
      "storefront:products",
      "max",
    );
  });

  it("does not repeat effects for an idempotent execution replay", async () => {
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
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/bulk-inventory-action`,
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
