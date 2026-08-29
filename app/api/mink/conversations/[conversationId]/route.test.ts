import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  actor: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  allowed: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: holder.enabled })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/persistence", () => ({
  getMinkConversation: holder.get,
  deleteMinkConversation: holder.delete,
  listMinkConversations: holder.list,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.allowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { DELETE, GET } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.allowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
  });
  holder.get.mockResolvedValue({
    id: ID,
    title: "Published products",
    messages: [
      { id: "message-1", role: "user", text: "How many?" },
      { id: "message-2", role: "assistant", text: "**14** products." },
    ],
  });
  holder.delete.mockResolvedValue(undefined);
  holder.list.mockResolvedValue([]);
});

describe("GET /api/mink/conversations/[conversationId]", () => {
  it("loads a conversation through the trusted actor scope", async () => {
    const response = await GET(request(), context(ID));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(holder.get).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      ID,
    );
    expect(body.conversation.messages).toHaveLength(2);
  });

  it("rejects an invalid id before resolving dashboard authority", async () => {
    const response = await GET(request(), context("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("does not expose history while Mink is disabled", async () => {
    holder.enabled = false;
    const response = await GET(request(), context(ID));

    expect(response.status).toBe(404);
    expect(holder.get).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/mink/conversations/[conversationId]", () => {
  it("deletes through the trusted actor scope and returns remaining history", async () => {
    const response = await DELETE(request(), context(ID));

    expect(response.status).toBe(200);
    expect(holder.delete).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      ID,
    );
    expect(holder.list).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ conversations: [] });
  });

  it("rejects a cross-origin deletion before resolving dashboard authority", async () => {
    const response = await DELETE(
      request({ origin: "https://attacker.example" }),
      context(ID),
    );

    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.delete).not.toHaveBeenCalled();
  });
});

function request(headers: Record<string, string> = {}) {
  return new Request(
    `https://echos.storemink.com/api/mink/conversations/${ID}`,
    { headers },
  );
}

function context(conversationId: string) {
  return { params: Promise.resolve({ conversationId }) };
}
