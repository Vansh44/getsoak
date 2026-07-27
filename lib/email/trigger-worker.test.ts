import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
// PLATFORM_URL is resolved at module load, so pin it rather than juggling env.
vi.mock("@/lib/store/host", () => ({
  PLATFORM_URL: "https://storemink.com",
  ROOT_DOMAIN: "storemink.com",
}));

import { triggerEmailWorker } from "./trigger-worker";
import { logWarn } from "@/lib/observability/logger";

const fetchMock = vi.fn();

describe("triggerEmailWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CRON_SECRET", "s3cret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("POSTs the worker route with the cron bearer token", async () => {
    await triggerEmailWorker();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://storemink.com/api/cron/send-emails");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer s3cret");
  });

  // REGRESSION. This used to read NEXT_PUBLIC_APP_URL directly and return early
  // when it was unset. The cron heartbeat is DAILY, so that silently turned
  // every "instant" email into a wait of up to 24 hours in any environment that
  // hadn't set that one variable — Cloud Run sets no VERCEL_URL either.
  it("still kicks the worker when NEXT_PUBLIC_APP_URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    await triggerEmailWorker();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://storemink.com/api/cron/send-emails",
    );
  });

  it("skips only when CRON_SECRET is missing — the route would 401 anyway", async () => {
    vi.stubEnv("CRON_SECRET", "");

    await triggerEmailWorker();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it("never throws into the caller when the kick fails", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    await expect(triggerEmailWorker()).resolves.toBeUndefined();
  });

  it("treats the 5s abort as normal — the worker is already running", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    await expect(triggerEmailWorker()).resolves.toBeUndefined();
  });
});
