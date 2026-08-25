import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const after = vi.hoisted(() => vi.fn());
const runHelpEmbeddingWorker = vi.hoisted(() => vi.fn());
const triggerHelpEmbeddingWorker = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/help/embedding-worker", () => ({ runHelpEmbeddingWorker }));
vi.mock("@/lib/help/embedding-trigger", () => ({
  triggerHelpEmbeddingWorker,
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { GET } from "./route";

const ORIGINAL_SECRET = process.env.CRON_SECRET;

function request(token = "s3cret") {
  return new Request("https://storemink.com/api/cron/help-embeddings", {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  runHelpEmbeddingWorker.mockResolvedValue({
    selected: 1,
    indexed: 1,
    removed: 0,
    stale: 0,
    failed: 0,
    chunks: 3,
    remaining: false,
  });
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("/api/cron/help-embeddings", () => {
  it("fails closed outside the cron secret gate", async () => {
    const response = await GET(request("wrong"));
    expect(response.status).toBe(401);
    expect(runHelpEmbeddingWorker).not.toHaveBeenCalled();
  });

  it("drains one bounded batch", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      worker: { indexed: 1, chunks: 3 },
    });
  });

  it("self-chains only while successful work remains", async () => {
    runHelpEmbeddingWorker.mockResolvedValue({
      selected: 8,
      indexed: 8,
      removed: 0,
      stale: 0,
      failed: 0,
      chunks: 24,
      remaining: true,
    });
    await GET(request());
    expect(after).toHaveBeenCalledOnce();
    const continuation = after.mock.calls[0][0] as () => Promise<void>;
    await continuation();
    expect(triggerHelpEmbeddingWorker).toHaveBeenCalledOnce();
  });

  it("returns retryable failure without spinning a self-chain", async () => {
    runHelpEmbeddingWorker.mockResolvedValue({
      selected: 8,
      indexed: 0,
      removed: 0,
      stale: 0,
      failed: 1,
      chunks: 0,
      remaining: true,
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(after).not.toHaveBeenCalled();
  });
});
