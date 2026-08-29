export class MinkRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryCount: number,
  ) {
    super("Mink provider request failed after bounded retries.");
    this.name = "MinkRetryError";
  }
}

export async function withMinkRetry<T>(input: {
  operation: () => Promise<T>;
  maxRetries: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
}): Promise<{ value: T; retryCount: number }> {
  let retryCount = 0;
  while (true) {
    try {
      return { value: await input.operation(), retryCount };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (!isRetryableProviderError(error) || retryCount >= input.maxRetries) {
        throw new MinkRetryError(error, retryCount);
      }
      retryCount += 1;
      await abortableDelay(
        (input.baseDelayMs ?? 250) * 2 ** (retryCount - 1),
        input.signal,
      );
    }
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  const status = providerStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }
  // fetch/undici uses TypeError for connection resets, DNS failures and other
  // failures that happen before an HTTP response exists.
  return error instanceof TypeError;
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}
