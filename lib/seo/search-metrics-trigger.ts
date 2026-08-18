import "server-only";

import { logError, logWarn } from "@/lib/observability/logger";
import { getRequestOrigin } from "@/lib/request-url";
import { PLATFORM_URL } from "@/lib/store/host";

export async function triggerSearchMetricWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logWarn("Search metric worker not chained (CRON_SECRET unset).");
    return;
  }
  const origin = getRequestOrigin() ?? PLATFORM_URL;
  try {
    await fetch(`${origin}/api/cron/search-metrics`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
  } catch (error) {
    logError("Search metric worker chain failed", error, { origin });
  }
}
