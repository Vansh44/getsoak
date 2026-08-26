import "server-only";

import { PLATFORM_URL } from "@/lib/store/host";
import { getRequestOrigin } from "@/lib/request-url";
import { logWarn } from "@/lib/observability/logger";

/**
 * Continue a bounded Help embedding backfill without holding one request.
 *
 * Prefer the current request's origin so a dashboard edit in local development
 * or staging wakes that same environment. Cron continuations have no request
 * scope and deliberately fall back to the configured platform origin.
 */
export async function triggerHelpEmbeddingWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logWarn("Help embedding worker not chained (CRON_SECRET unset).");
    return;
  }
  const origin = (await getRequestOrigin()) ?? PLATFORM_URL;
  try {
    const response = await fetch(`${origin}/api/cron/help-embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logWarn("Help embedding worker chain failed", {
        origin,
        status: response.status,
      });
    }
  } catch (error) {
    // The worker is already running when the delivery request reaches its
    // five-second bound, so a local timeout is not an indexing failure.
    if (error instanceof Error && error.name === "TimeoutError") return;
    logWarn("Help embedding worker chain failed", {
      origin,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
