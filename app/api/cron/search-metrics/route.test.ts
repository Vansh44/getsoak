import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const after = vi.hoisted(() => vi.fn());
const prepareSearchMetricWork = vi.hoisted(() => vi.fn());
const runSearchMetricWorker = vi.hoisted(() => vi.fn());
const triggerSearchMetricWorker = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/seo/search-metrics", () => ({
  prepareSearchMetricWork,
  runSearchMetricWorker,
}));
vi.mock("@/lib/seo/search-metrics-trigger", () => ({
  triggerSearchMetricWorker,
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { GET, POST } from "./route";

const ORIGINAL_SECRET = process.env.CRON_SECRET;

function request(method: "GET" | "POST", token = "s3cret") {
  return new Request("https://storemink.com/api/cron/search-metrics", {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  prepareSearchMetricWork.mockResolvedValue({
    stores: 2,
    sources: 2,
    jobs: 30,
  });
  runSearchMetricWorker.mockResolvedValue({
    processed: 1,
    remaining: false,
    status: "completed",
  });
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("/api/cron/search-metrics", () => {
  it("rejects requests outside the cron secret gate", async () => {
    const response = await GET(request("GET", "wrong"));
    expect(response.status).toBe(401);
    expect(prepareSearchMetricWork).not.toHaveBeenCalled();
  });

  it("prepares the correction window only on the Scheduler GET", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(prepareSearchMetricWork).toHaveBeenCalledOnce();
    expect(runSearchMetricWorker).toHaveBeenCalledOnce();

    await POST(request("POST"));
    expect(prepareSearchMetricWork).toHaveBeenCalledOnce();
    expect(runSearchMetricWorker).toHaveBeenCalledTimes(2);
  });

  it("self-chains while durable work remains", async () => {
    runSearchMetricWorker.mockResolvedValue({
      processed: 1,
      remaining: true,
      status: "completed",
    });
    await GET(request("GET"));
    expect(after).toHaveBeenCalledOnce();
    const continuation = after.mock.calls[0][0] as () => Promise<void>;
    await continuation();
    expect(triggerSearchMetricWorker).toHaveBeenCalledOnce();
  });
});
