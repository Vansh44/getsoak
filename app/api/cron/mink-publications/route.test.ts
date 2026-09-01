import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runWorker = vi.fn();

vi.mock("@/lib/mink/blog-publication-worker", () => ({
  runMinkBlogPublicationWorker: runWorker,
}));

describe("Mink scheduled-publication cron", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    runWorker.mockReset().mockResolvedValue({
      processed: 2,
      published: 1,
      conflicted: 1,
      failed: 0,
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("fails closed when the cron secret is missing", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-publications"),
    );
    expect(response.status).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://storemink.com/api/cron/mink-publications", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(response.status).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("runs the bounded worker for an authenticated heartbeat", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-publications", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      processed: 2,
      published: 1,
      conflicted: 1,
      failed: 0,
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("stays 200 while a run that hit a failed row still made progress", async () => {
    runWorker.mockResolvedValue({
      processed: 1,
      published: 1,
      conflicted: 0,
      failed: 1,
    });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-publications", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    // A permanently red job is one nobody reads; the row is retried next tick.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      failed: 1,
    });
  });

  it("answers 503 when the run made no progress at all", async () => {
    runWorker.mockResolvedValue({
      processed: 0,
      published: 0,
      conflicted: 0,
      failed: 1,
    });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-publications", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(503);
  });
});
