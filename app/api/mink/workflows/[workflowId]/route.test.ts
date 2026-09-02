import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  actor: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  rateAllowed: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: true, betaRequireInvite: true })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/workflows", () => ({
  getMinkWorkflow: holder.getWorkflow,
  cancelMinkWorkflow: holder.cancelWorkflow,
  resumeMinkWorkflow: holder.resumeWorkflow,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET, POST } from "./route";

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const PARAMS = { params: Promise.resolve({ workflowId: WORKFLOW_ID }) };
const workflow = {
  id: WORKFLOW_ID,
  status: "queued",
  currentStep: 0,
  totalSteps: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  holder.rateAllowed = true;
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    isSuperadmin: true,
    permissions: {},
  });
  holder.getWorkflow.mockResolvedValue(workflow);
  holder.cancelWorkflow.mockResolvedValue({ ...workflow, status: "cancelled" });
  holder.resumeWorkflow.mockResolvedValue(workflow);
});

describe("Mink workflow API", () => {
  it("loads only through the trusted actor boundary and disables caching", async () => {
    const response = await GET(
      new Request(
        `https://acme.storemink.com/api/mink/workflows/${WORKFLOW_ID}`,
      ),
      PARAMS,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.getWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      WORKFLOW_ID,
    );
  });

  it("rejects malformed ids before authentication or database access", async () => {
    const response = await GET(
      new Request("https://acme.storemink.com/api/mink/workflows/not-a-uuid"),
      { params: Promise.resolve({ workflowId: "not-a-uuid" }) },
    );
    expect(response.status).toBe(400);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.getWorkflow).not.toHaveBeenCalled();
  });

  it("rejects cross-origin state changes before authentication", async () => {
    const response = await POST(
      request({ action: "cancel" }, "https://attacker.example"),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
    expect(holder.cancelWorkflow).not.toHaveBeenCalled();
  });

  it("accepts only the bounded cancel/resume contract", async () => {
    const oversized = await POST(
      request({ action: "cancel", padding: "x".repeat(1_100) }),
      PARAMS,
    );
    expect(oversized.status).toBe(413);

    const unknown = await POST(request({ action: "restart" }), PARAMS);
    expect(unknown.status).toBe(400);

    const cancelled = await POST(request({ action: "cancel" }), PARAMS);
    expect(cancelled.status).toBe(200);
    expect(holder.cancelWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", adminId: "admin-1" }),
      WORKFLOW_ID,
    );
  });

  it("fails closed when Analytics View was removed", async () => {
    holder.actor.mockResolvedValue({
      storeId: "store-1",
      adminId: "admin-1",
      isSuperadmin: false,
      permissions: {},
    });
    const response = await GET(
      new Request(
        `https://acme.storemink.com/api/mink/workflows/${WORKFLOW_ID}`,
      ),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(holder.getWorkflow).not.toHaveBeenCalled();
  });
});

function request(body: unknown, origin = "https://acme.storemink.com") {
  return new Request(
    `https://acme.storemink.com/api/mink/workflows/${WORKFLOW_ID}`,
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
