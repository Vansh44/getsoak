import "server-only";

import { PLATFORM_URL } from "@/lib/store/host";
import { getRequestOrigin } from "@/lib/request-url";
import { logError, logWarn } from "@/lib/observability/logger";

/**
 * Kick the import worker without blocking the caller.
 *
 * THIS IS WHAT MAKES AN IMPORT START NOW. The cron heartbeat is a BACKSTOP for
 * chains that break, not the normal path — without this kick a merchant would
 * upload a file and watch nothing happen until the next sweep. Exactly the
 * relationship `triggerEmailWorker` has with `/api/cron/send-emails`, and this
 * mirrors it deliberately rather than inventing a second mechanism.
 *
 * ORIGIN: THE CURRENT REQUEST'S HOST, not a configured one — the lesson
 * recorded in lib/email/trigger-worker.ts. Resolving it from env meant a
 * developer importing on echos.localhost:3000 POSTed the kick to
 * https://staging.storemink.com, telling another environment to drain a queue
 * that wasn't ours, using our CRON_SECRET. PLATFORM_URL stays the fallback for
 * callers with no request scope (the cron route chaining itself).
 *
 * Fire-and-forget: a failed kick costs latency, not correctness, because the
 * cron sweep picks the job up regardless.
 */
export async function triggerImportWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logWarn(
      "Import worker not kicked (CRON_SECRET unset); the cron sweep will pick the job up.",
    );
    return;
  }

  const origin = getRequestOrigin() ?? PLATFORM_URL;
  try {
    await fetch(`${origin}/api/cron/import-worker`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      // Never hold the caller's response open on this.
      cache: "no-store",
    });
  } catch (error) {
    logError("import worker kick failed", error, { origin });
  }
}
