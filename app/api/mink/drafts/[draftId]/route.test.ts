import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  getDraft: vi.fn(),
  saveDraft: vi.fn(),
  rollbackDraft: vi.fn(),
  rateAllowed: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: true })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/drafts", () => ({
  getMinkDraft: holder.getDraft,
  saveMinkDraftVersion: holder.saveDraft,
  rollbackMinkDraftVersion: holder.rollbackDraft,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET, POST } from "./route";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const PARAMS = { params: Promise.resolve({ draftId: DRAFT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  holder.rateAllowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    draftingEnabled: true,
  });
  holder.getDraft.mockResolvedValue({ id: DRAFT_ID, currentVersion: 0 });
  holder.saveDraft.mockResolvedValue({ id: DRAFT_ID, currentVersion: 1 });
  holder.rollbackDraft.mockResolvedValue({ id: DRAFT_ID, currentVersion: 2 });
});

describe("Mink private draft API", () => {
  it("loads only through the trusted actor boundary with no-store caching", async () => {
    const response = await GET(
      new Request(`https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}`),
      PARAMS,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.getDraft).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      DRAFT_ID,
    );
  });

  it("rejects cross-origin draft writes before authentication", async () => {
    const response = await POST(
      request(
        { action: "save", expectedVersion: 0, content: { body: "Hi" } },
        "https://attacker.example",
      ),
      PARAMS,
    );

    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.saveDraft).not.toHaveBeenCalled();
  });

  it("passes the current version and content to the scoped save operation", async () => {
    const content = { description: "Clear, honest copy." };
    const response = await POST(
      request({ action: "save", expectedVersion: 0, content }),
      PARAMS,
    );

    expect(response.status).toBe(200);
    expect(holder.saveDraft).toHaveBeenCalledWith({
      actor: expect.objectContaining({
        storeId: "store-1",
        adminId: "admin-1",
      }),
      draftId: DRAFT_ID,
      expectedVersion: 0,
      content,
    });
  });

  it("enforces the draft body bound from actual streamed bytes", async () => {
    const response = await POST(
      request({
        action: "save",
        expectedVersion: 0,
        content: { lines_json: "x".repeat(33_000) },
      }),
      PARAMS,
    );
    expect(response.status).toBe(413);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.saveDraft).not.toHaveBeenCalled();
  });

  it("rejects unsupported top-level mutation fields", async () => {
    const response = await POST(
      request({
        action: "save",
        expectedVersion: 0,
        content: { description: "Safe" },
        storeId: "foreign-store",
      }),
      PARAMS,
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("requires a positive target for a rollback", async () => {
    const rejected = await POST(
      request({ action: "rollback", expectedVersion: 2, targetVersion: 0 }),
      PARAMS,
    );
    expect(rejected.status).toBe(400);
    expect(holder.rollbackDraft).not.toHaveBeenCalled();

    const accepted = await POST(
      request({ action: "rollback", expectedVersion: 2, targetVersion: 1 }),
      PARAMS,
    );
    expect(accepted.status).toBe(200);
    expect(holder.rollbackDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: DRAFT_ID,
        expectedVersion: 2,
        targetVersion: 1,
      }),
    );
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(`https://acme.storemink.com/api/mink/drafts/${DRAFT_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      host: "acme.storemink.com",
    },
    body: JSON.stringify(body),
  });
}
