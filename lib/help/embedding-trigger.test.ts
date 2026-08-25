import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/store/host", () => ({
  PLATFORM_URL: "https://storemink.com",
}));
const requestOrigin = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/lib/request-url", () => ({
  getRequestOrigin: vi.fn(async () => requestOrigin.value),
}));
vi.mock("@/lib/observability/logger", () => ({
  logWarn: vi.fn(),
}));

import { logWarn } from "@/lib/observability/logger";
import { triggerHelpEmbeddingWorker } from "./embedding-trigger";

const fetchMock = vi.fn();

describe("triggerHelpEmbeddingWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    requestOrigin.value = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("falls back to the platform origin outside request scope", async () => {
    await triggerHelpEmbeddingWorker();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://storemink.com/api/cron/help-embeddings",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
      cache: "no-store",
    });
  });

  it("wakes the environment serving the current request", async () => {
    requestOrigin.value = "http://echos.localhost:3000";

    await triggerHelpEmbeddingWorker();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://echos.localhost:3000/api/cron/help-embeddings",
    );
  });

  it("does not call a route that would reject a missing cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "");

    await triggerHelpEmbeddingWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "Help embedding worker not chained (CRON_SECRET unset).",
    );
  });

  it("reports a rejected continuation without throwing into the caller", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(triggerHelpEmbeddingWorker()).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      "Help embedding worker chain failed",
      expect.objectContaining({
        origin: "https://storemink.com",
        status: 503,
      }),
    );
  });

  it("fails soft on delivery errors and treats its timeout as normal", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    await expect(triggerHelpEmbeddingWorker()).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      "Help embedding worker chain failed",
      expect.objectContaining({
        origin: "https://storemink.com",
        error: "connection refused",
      }),
    );

    vi.clearAllMocks();
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(triggerHelpEmbeddingWorker()).resolves.toBeUndefined();
    expect(logWarn).not.toHaveBeenCalled();
  });
});
