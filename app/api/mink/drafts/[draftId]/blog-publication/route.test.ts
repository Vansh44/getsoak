import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  notify: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  rateAllowed: true,
}));

vi.mock("next/cache", () => ({
  revalidatePath: holder.revalidatePath,
  revalidateTag: holder.revalidateTag,
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
vi.mock("@/lib/mink/blog-publication-actions", () => ({
  previewMinkBlogPublication: holder.preview,
  executeMinkBlogPublication: holder.execute,
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: holder.notify,
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
const EXECUTION = {
  approval: {
    id: APPROVAL_ID,
    draftId: DRAFT_ID,
    operation: "apply",
    toolName: "publish_blog",
    resource: {
      type: "blog",
      id: "blog-1",
      label: "Safe article",
      dashboardPath: "/dashboard/blogs",
    },
    before: { publication_status: "Private draft" },
    after: { publication_status: "Published" },
  },
  auditId: "audit-1",
  repeated: false,
  publication: {
    id: "publication-1",
    mode: "publish_now",
    status: "published",
    scheduledFor: null,
    publishedAt: "2026-09-01T04:00:00.000Z",
  },
  notifyPublication: true,
  publishedSlug: "safe-article",
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
  holder.notify.mockResolvedValue(undefined);
});

describe("Mink Phase 5D blog publication API", () => {
  it("rejects cross-origin requests before authentication", async () => {
    const response = await POST(
      request(
        {
          action: "preview",
          expectedDraftVersion: 1,
          idempotencyKey: IDEMPOTENCY_KEY,
          mode: "publish_now",
        },
        "https://attacker.example",
      ),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("previews an immediate publication from server-side draft data", async () => {
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 2,
        idempotencyKey: IDEMPOTENCY_KEY,
        mode: "publish_now",
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.preview).toHaveBeenCalledWith({
      actor: expect.objectContaining({ storeId: "store-1" }),
      draftId: DRAFT_ID,
      expectedDraftVersion: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
      mode: "publish_now",
      scheduledFor: undefined,
    });
  });

  it("passes only a timezone-bearing schedule to the policy boundary", async () => {
    const scheduledFor = "2026-09-02T06:30:00.000Z";
    const response = await POST(
      request({
        action: "preview",
        expectedDraftVersion: 2,
        idempotencyKey: IDEMPOTENCY_KEY,
        mode: "schedule",
        scheduledFor,
      }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.preview).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "schedule", scheduledFor }),
    );
  });

  it("rejects browser-supplied blog fields before authentication", async () => {
    const response = await POST(
      request({
        action: "execute",
        approvalId: APPROVAL_ID,
        title: "Attacker title",
        content: "<script>alert(1)</script>",
        storeId: "attacker-store",
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

  it("executes only by approval id and strips server-only hints", async () => {
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
    const payload = await response.json();
    expect(payload.result.notifyPublication).toBeUndefined();
    expect(payload.result.publishedSlug).toBeUndefined();
    expect(holder.notify).toHaveBeenCalledWith({
      storeId: "store-1",
      paths: ["/blogs/safe-article", "/blogs", "/"],
    });
  });

  it("does not notify discovery again for an idempotent replay", async () => {
    holder.execute.mockResolvedValueOnce({
      ...EXECUTION,
      repeated: true,
      notifyPublication: false,
      publishedSlug: null,
    });
    const response = await POST(
      request({ action: "execute", approvalId: APPROVAL_ID }),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(holder.notify).not.toHaveBeenCalled();
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}/blog-publication`,
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
