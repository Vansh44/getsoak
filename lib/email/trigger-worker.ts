import "server-only";

import { PLATFORM_URL } from "@/lib/store/host";
import { getRequestOrigin } from "@/lib/request-url";
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
 * ORIGIN: THE CURRENT REQUEST'S HOST, not a configured one.
 *
 * A worker kick must land on THIS process. Resolving it from env instead meant
 * a developer placing an order on echos.localhost:3000 POSTed the kick to
 * https://staging.storemink.com — a different environment, told to drain a
 * queue that isn't ours, using our CRON_SECRET. (An earlier version read
 * NEXT_PUBLIC_APP_URL directly and bailed when unset: safe, but it silently
 * lost instant email on any host that hadn't set that one variable, since
 * Cloud Run sets no VERCEL_URL either.)
 *
 * getRequestOrigin() is the same helper the invite and POS emails use to build
 * links that work in every environment. PLATFORM_URL remains the fallback for
 * callers with no request scope — the cron route chaining itself, where the
 * apex is exactly right.
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
  const origin = (await getRequestOrigin()) ?? PLATFORM_URL;
  try {
    await fetch(`${origin}/api/cron/send-emails`, {
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
