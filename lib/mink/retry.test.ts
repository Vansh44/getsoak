import { describe, expect, it, vi } from "vitest";
import { MinkRetryError, withMinkRetry } from "./retry";

describe("withMinkRetry", () => {
  it("retries one transient provider failure and reports the attempt", async () => {
    const operation = vi
      .fn(async (): Promise<string> => "ok")
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    await expect(
      withMinkRetry({ operation, maxRetries: 1, baseDelayMs: 0 }),
    ).resolves.toEqual({ value: "ok", retryCount: 1 });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient provider rejection", async () => {
    const rejection = Object.assign(new Error("bad request"), { status: 400 });
    const operation = vi.fn(async () => {
      throw rejection;
    });

    await expect(
      withMinkRetry({ operation, maxRetries: 2, baseDelayMs: 0 }),
    ).rejects.toMatchObject({
      originalError: rejection,
      retryCount: 0,
    } satisfies Partial<MinkRetryError>);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("stops immediately when the enclosing run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new TypeError("network");
    const operation = vi.fn(async () => {
      throw failure;
    });

    await expect(
      withMinkRetry({
        operation,
        maxRetries: 2,
        signal: controller.signal,
        baseDelayMs: 0,
      }),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
  });
});
