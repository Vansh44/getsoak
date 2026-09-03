import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runWorker = vi.fn();

vi.mock("@/lib/mink/workflows", () => ({
  runMinkWorkflowWorker: runWorker,
}));

describe("Mink workflow cron", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    runWorker.mockReset().mockResolvedValue({
      claims: 3,
      stepsCompleted: 3,
      workflowsCompleted: 1,
      workflowsCancelled: 0,
      retriesScheduled: 0,
      workflowsFailed: 0,
      notificationsDelivered: 1,
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("fails closed without the exact cron bearer token", async () => {
    const { GET, POST } = await import("./route");
    const missing = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows"),
    );
    const wrong = await POST(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("runs one bounded heartbeat for either supported cron method", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      claims: 3,
      workflowsCompleted: 1,
      notificationsDelivered: 1,
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
  });
});
