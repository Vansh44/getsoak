import { beforeEach, describe, it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({
  actor: vi.fn(),
  list: vi.fn(),
  change: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/lib/mink/actor-context", () => ({ getMinkActorContext: h.actor }));
vi.mock("@/lib/mink/memories", () => ({
  listMinkMemories: h.list,
  changeMinkMemory: h.change,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.rate }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import { GET, POST } from "./route";
const url = "https://echos.dev.storemink.com/api/mink/memories";
beforeEach(() => {
  vi.resetAllMocks();
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.list.mockResolvedValue([]);
  h.change.mockResolvedValue({ deleted: true });
  h.rate.mockResolvedValue({ allowed: true });
});
describe("memory endpoint", () => {
  it("uses trusted owner, keeps responses private and allows cleanup while invite-gated off", async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(h.actor).toHaveBeenCalledWith(expect.any(String), {
      betaRequireInvite: false,
    });
    expect(h.list).toHaveBeenCalledWith({ storeId: "echos", adminId: "owner" });
  });
  it("rejects foreign origins before auth or mutation", async () => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(h.actor).not.toHaveBeenCalled();
    expect(h.change).not.toHaveBeenCalled();
  });
  it("enforces body size even without a content-length header", async () => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        headers: { origin: new URL(url).origin },
        body: JSON.stringify({ text: "x".repeat(9000) }),
      }),
    );
    expect(res.status).toBe(413);
    expect(h.change).not.toHaveBeenCalled();
  });
  it("rate limits writes", async () => {
    h.rate.mockResolvedValue({ allowed: false });
    expect(
      (await POST(new Request(url, { method: "POST", body: "{}" }))).status,
    ).toBe(429);
    expect(h.change).not.toHaveBeenCalled();
  });
  it("does not expose internal database errors", async () => {
    h.list.mockRejectedValue(new Error("secret SQL"));
    const res = await GET(new Request(url));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("secret SQL");
  });
  it("forwards only the trusted actor with the validated JSON object", async () => {
    const res = await POST(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ action: "delete_all", confirmed: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.change).toHaveBeenCalledWith(
      { storeId: "echos", adminId: "owner" },
      { action: "delete_all", confirmed: true },
    );
  });
});
