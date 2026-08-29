import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  allowed: true,
  actor: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({
    enabled: holder.enabled,
    betaRequireInvite: true,
  })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/feedback", () => ({
  saveMinkFeedback: holder.save,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.allowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";

const RUN_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.allowed = true;
  holder.actor.mockResolvedValue({ storeId: "store-1", adminId: "admin-1" });
  holder.save.mockResolvedValue({
    rating: "helpful",
    issueCategory: null,
  });
});

describe("POST /api/mink/feedback", () => {
  it("saves feedback only after trusted invited actor construction", async () => {
    const response = await POST(
      request({ runId: RUN_ID, rating: "helpful", details: "Useful" }),
    );

    expect(response.status).toBe(200);
    expect(holder.actor).toHaveBeenCalledWith(expect.any(String), {
      betaRequireInvite: true,
    });
    expect(holder.save).toHaveBeenCalledWith({
      actor: expect.objectContaining({
        storeId: "store-1",
        adminId: "admin-1",
      }),
      runId: RUN_ID,
      rating: "helpful",
      issueCategory: null,
      details: "Useful",
    });
  });

  it("requires an issue for an unhelpful rating", async () => {
    const response = await POST(
      request({ runId: RUN_ID, rating: "unhelpful", details: "Wrong" }),
    );

    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.save).not.toHaveBeenCalled();
  });

  it("rejects foreign origins and disabled deployments before actor lookup", async () => {
    const foreign = await POST(
      request(
        { runId: RUN_ID, rating: "helpful" },
        { origin: "https://attacker.example" },
      ),
    );
    expect(foreign.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();

    holder.enabled = false;
    const disabled = await POST(request({ runId: RUN_ID, rating: "helpful" }));
    expect(disabled.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rate limits before storing feedback", async () => {
    holder.allowed = false;

    const response = await POST(
      request({
        runId: RUN_ID,
        rating: "unhelpful",
        issueCategory: "privacy",
      }),
    );

    expect(response.status).toBe(429);
    expect(holder.save).not.toHaveBeenCalled();
  });
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://echos.storemink.com/api/mink/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
