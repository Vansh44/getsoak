import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  actor: vi.fn(),
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
  listMinkConversations: holder.list,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.allowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.allowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
  });
  holder.list.mockResolvedValue([
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Published products",
      lastMessageAt: "2026-08-29T09:00:00.000Z",
      createdAt: "2026-08-29T08:59:00.000Z",
    },
  ]);
});

describe("GET /api/mink/conversations", () => {
  it("lists only conversations returned for the trusted actor", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.list).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
    );
    expect(body.conversations).toHaveLength(1);
  });

  it("is unavailable while the private Mink flag is off", async () => {
    holder.enabled = false;
    const response = await GET();

    expect(response.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rate limits history reads per actor", async () => {
    holder.allowed = false;
    const response = await GET();

    expect(response.status).toBe(429);
    expect(holder.list).not.toHaveBeenCalled();
  });
});
