// ---------------------------------------------------------------------------
// Digest windows — when a queued notification email becomes eligible to send.
//
// Pure (no Date.now() unless you omit `from`) so the boundaries are testable
// without freezing the clock.
//
// The windows are deliberately aligned to CLOCK boundaries rather than "now +
// 1 hour": everything that happens between 14:00 and 15:00 shares one send
// time, so it leaves as ONE grouped email. A rolling window would give each
// event its own deadline and quietly degrade back into one email per event —
// the exact thing digests exist to prevent.
//
// DUE ≠ SENT. A row is sent by the next worker run after it comes due, and the
// cron heartbeat is currently DAILY (Vercel Hobby caps crons at once/day — see
// the same note on the payments reaper, §18). In practice most runs are
// triggered by an instant email being enqueued, which drains every due row
// including digests. So daily digests are punctual (see the hour below) and
// HOURLY digests are best-effort until the worker can run hourly — which comes
// free with Cloud Scheduler at the Cloud Run cutover.
// ---------------------------------------------------------------------------

import type { Digest } from "./events";

/**
 * The hour (UTC) a daily digest becomes DUE.
 *
 * Deliberately 23:00, an hour before the `/api/cron/send-emails` heartbeat at
 * 00:00 UTC (vercel.json): a row is only SENT by the next worker run after it
 * comes due, so a slot dated after the cron would wait an entire extra day.
 * Landing just before it means the digest goes out at ~00:00 UTC — 05:30 IST,
 * which for an India-first product is the merchant's morning summary.
 *
 * ⚠ If the cron schedule moves, move this with it.
 */
export const DAILY_DIGEST_HOUR_UTC = 23;

/**
 * When an event queued at `from` should be sent, given its digest setting.
 *   instant → immediately
 *   hourly  → the top of the next hour
 *   daily   → the next DAILY_DIGEST_HOUR_UTC (today's if still ahead)
 */
export function digestSendAfter(digest: Digest, from: Date = new Date()): Date {
  if (digest === "hourly") {
    const next = new Date(from);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  if (digest === "daily") {
    const next = new Date(from);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(DAILY_DIGEST_HOUR_UTC);
    // Already past today's slot → tomorrow's.
    if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  return new Date(from);
}
