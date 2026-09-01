import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
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
vi.mock("@/lib/mink/bulk-price-actions", async () => {
  const { MinkRequestError } = await import("@/lib/mink/errors");
  return {
    MinkBulkPriceValidationError: class extends MinkRequestError {
      constructor(
        message: string,
        public readonly lineErrors: unknown[],
      ) {
        super("mink_bulk_price_lines_invalid", message, 409);
      }
    },
    previewMinkBulkPriceAction: holder.preview,
    executeMinkBulkPriceAction: holder.execute,
  };
});
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
const RESULT = {
  approval: {
    id: APPROVAL_ID,
    draftId: DRAFT_ID,
    lines: [
      {
        line: 1,
        productId: "product-1",
        variantId: "variant-1",
        product: "Tea",
        variant: "500 g",
        sku: "TEA-500",
        before: { effectivePrice: "100.00" },
        after: { effectivePrice: "90.00" },
      },
      {
        line: 2,
        productId: "product-2",
        variantId: null,
        product: "Coffee",
        variant: null,
        sku: "COFFEE",
        before: { effectivePrice: "200.00" },
        after: { effectivePrice: "220.00" },
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
  holder.execute.mockResolvedValue(RESULT);
});

describe("Mink Phase 5F bulk price action API", () => {
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

  it("rejects browser-supplied prices before authentication", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        lines: [{ sku: "ATTACK", selling_price: "1.00" }],
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

  it("returns bounded line corrections", async () => {
    const { MinkBulkPriceValidationError } =
      await import("@/lib/mink/bulk-price-actions");
    holder.preview.mockRejectedValueOnce(
      new MinkBulkPriceValidationError("Two price lines need correction.", [
        {
          line: 1,
          sku: "MISSING",
          code: "sku_not_found",
          message: "The exact SKU was not found in this store.",
        },
        {
          line: 2,
          sku: "TEA-500",
          code: "price_order_invalid",
          message: "MRP must be at least the selling price.",
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
    expect(await response.json()).toEqual({
      error: "Two price lines need correction.",
      code: "mink_bulk_price_lines_invalid",
      lineErrors: expect.arrayContaining([
        expect.objectContaining({ line: 1, code: "sku_not_found" }),
        expect.objectContaining({ line: 2, code: "price_order_invalid" }),
      ]),
    });
  });

  it("rate-limits before domain execution", async () => {
    holder.rateAllowed = false;
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(429);
    expect(holder.execute).not.toHaveBeenCalled();
  });

  it("emits bounded product events and invalidates product views", async () => {
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.emit).toHaveBeenCalledTimes(2);
    expect(holder.emit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "product.updated",
        storeId: "store-1",
        payload: expect.objectContaining({
          source: "mink_ai_bulk_price",
          approvalId: APPROVAL_ID,
          sku: "TEA-500",
        }),
      }),
    );
    expect(holder.revalidatePath).toHaveBeenCalledWith("/dashboard/products");
    expect(holder.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/products/product-1",
    );
    expect(holder.revalidateTag).toHaveBeenCalledWith(
      "storefront:products",
      "max",
    );
  });

  it("does not repeat events for an idempotent replay", async () => {
    holder.execute.mockResolvedValueOnce({ ...RESULT, repeated: true });
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
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/bulk-price-action`,
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
