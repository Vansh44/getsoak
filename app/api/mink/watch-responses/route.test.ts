import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  actor: vi.fn(),
  list: vi.fn(),
  decide: vi.fn(),
  allowed: true,
}));
vi.mock("@/lib/mink/actor-context", () => ({ getMinkActorContext: h.actor }));
vi.mock("@/lib/mink/proactive-responses", () => ({
  listProactiveResponses: h.list,
  decideProactiveResponse: h.decide,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ allowed: h.allowed }),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import { GET, POST } from "./route";
import { MinkRequestError } from "@/lib/mink/errors";
const url =
  "https://echos.storemink.com/api/mink/watch-responses?watchId=watch";
const request = (body: unknown, origin = "https://echos.storemink.com") =>
  new Request(url, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.allowed = true;
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.list.mockResolvedValue({ plans: [] });
  h.decide.mockResolvedValue({ status: "approved", workflowId: "one" });
});
describe("response API boundaries", () => {
  it("uses trusted session scope and prevents caching", async () => {
    const r = await GET(new Request(url));
    expect(r.status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(
      { storeId: "echos", adminId: "owner" },
      "watch",
    );
    expect(r.headers.get("cache-control")).toContain("no-store");
  });
  it("blocks cross-origin changes before authentication or writes", async () => {
    expect((await POST(request({}, "https://evil.example"))).status).toBe(403);
    expect(h.actor).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
  });
  it.each([null, [], true, "approve"])(
    "rejects malformed body %j",
    async (value) => {
      expect((await POST(request(value))).status).toBe(400);
      expect(h.decide).not.toHaveBeenCalled();
    },
  );
  it("bounds streamed input independent of content-length", async () => {
    expect((await POST(request({ blob: "x".repeat(3000) }))).status).toBe(413);
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("enforces rate limits before service mutation", async () => {
    h.allowed = false;
    expect((await POST(request({}))).status).toBe(429);
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("reports permission and stale-plan rejection faithfully", async () => {
    h.decide.mockRejectedValue(
      new MinkRequestError("stale", "Refresh the plan", 409),
    );
    expect((await POST(request({}))).status).toBe(409);
  });
  it("never exposes internal database errors", async () => {
    h.list.mockRejectedValue(new Error("secret connection string"));
    const r = await GET(new Request(url));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
  });
});
