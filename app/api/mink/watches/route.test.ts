import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  actor: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  change: vi.fn(),
  enabled: true,
  allowed: true,
}));
vi.mock("@/lib/mink/actor-context", () => ({ getMinkActorContext: h.actor }));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: h.enabled }),
}));
vi.mock("@/lib/mink/watches", () => ({
  listMinkWatches: h.list,
  createMinkWatch: h.create,
  changeMinkWatch: h.change,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ allowed: h.allowed }),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import { GET, POST } from "./route";
import { MinkRequestError } from "@/lib/mink/errors";
const url = "https://echos.storemink.com/api/mink/watches";
function request(body: unknown, origin = "https://echos.storemink.com") {
  return new Request(url, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.allowed = true;
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.list.mockResolvedValue({ watches: [] });
  h.create.mockResolvedValue({ id: "watch" });
  h.change.mockResolvedValue({ id: "watch" });
});
describe("watch request boundary", () => {
  it("reads using trusted identity and private no-store headers", async () => {
    const r = await GET(new Request(url));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(h.list).toHaveBeenCalledWith({ storeId: "echos", adminId: "owner" });
  });
  it("rejects cross-origin mutations before actor resolution", async () => {
    expect(
      (await POST(request({ action: "pause" }, "https://evil.example"))).status,
    ).toBe(403);
    expect(h.actor).not.toHaveBeenCalled();
  });
  it.each([null, [], { action: ["resume"] }, { action: "run_shell" }])(
    "rejects malformed action %j",
    async (value) => {
      expect((await POST(request(value))).status).toBe(400);
      expect(h.change).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    },
  );
  it("bounds streamed bodies even without content-length", async () => {
    expect(
      (await POST(request({ action: "create", blob: "x".repeat(5000) })))
        .status,
    ).toBe(413);
    expect(h.create).not.toHaveBeenCalled();
  });
  it("rate-limits writes", async () => {
    h.allowed = false;
    expect((await POST(request({ action: "create" }))).status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
  });
  it("does not enable new work when disabled", async () => {
    h.enabled = false;
    expect((await POST(request({ action: "create" }))).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each(["pause", "delete"])(
    "allows owner stop control %s while disabled",
    async (action) => {
      h.enabled = false;
      expect(
        (await POST(request({ action, id: "watch", version: 1 }))).status,
      ).toBe(200);
      expect(h.change).toHaveBeenCalled();
    },
  );
  it("rechecks invite policy for activation", async () => {
    expect((await POST(request({ action: "create" }))).status).toBe(200);
    expect(h.actor).toHaveBeenCalledTimes(2);
    expect(h.actor.mock.calls[1]).toHaveLength(1);
  });
  it("preserves explicit permission errors", async () => {
    h.actor.mockRejectedValueOnce(
      new MinkRequestError("not_signed_in", "Not signed in", 401),
    );
    expect((await GET(new Request(url))).status).toBe(401);
  });
  it("does not expose database exception details", async () => {
    h.list.mockRejectedValueOnce(new Error("secret SQL"));
    const r = await GET(new Request(url));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret SQL");
  });
});
