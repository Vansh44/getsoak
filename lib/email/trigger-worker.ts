import "server-only";

import { PLATFORM_URL } from "@/lib/store/host";
import { logError, logWarn } from "@/lib/observability/logger";

/**
 * Fire the background email worker without blocking the caller. Called right
 * after mail is enqueued (a campaign, or a notification with an instant email
 * channel) so the queue starts draining in seconds instead of waiting for the
 * next cron tick.
 *
 * THIS IS WHAT MAKES "INSTANT" INSTANT. The cron heartbeat is DAILY (Vercel
 * Hobby caps crons at one a day — see vercel.json), so if this kick doesn't
 * land, an order-confirmation email waits up to 24 hours. That failure is
 * silent: the mail is queued, nothing errors, it just sits there.
 *
 * Which is why the origin comes from PLATFORM_URL — the resolver that already
 * falls back NEXT_PUBLIC_APP_URL → VERCEL_URL → https://{ROOT_DOMAIN} — rather
 * than reading one env var and giving up when it's unset. It previously read
 * NEXT_PUBLIC_APP_URL directly, so an environment that hadn't set that one
 * variable (Cloud Run sets no VERCEL_URL either) silently lost instant email
 * even though the apex would have worked fine.
 *
 * CRON_SECRET is genuinely required: without it the worker route 401s, so
 * there is nothing useful to attempt.
 */
export async function triggerEmailWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logWarn(
      "Email worker not kicked (CRON_SECRET unset); the cron job will drain the queue.",
    );
    return;
  }
  try {
    await fetch(`${PLATFORM_URL}/api/cron/send-emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      // Don't hold the triggering request open waiting for a full drain — the
      // worker keeps running server-side; we only need the kick delivered.
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    // A timeout here is EXPECTED on a long drain and is not a failure: the
    // worker is already running. Anything else is worth seeing.
    if (error instanceof Error && error.name === "TimeoutError") return;
    logError("Failed to trigger email worker", error);
  }
}
