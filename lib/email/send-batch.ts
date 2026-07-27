import "server-only";

// ---------------------------------------------------------------------------
// Batch send with a per-message fallback — the "one poison message" fix.
//
// Resend's batch.send validates the whole request: ONE bad recipient and the
// call returns an error covering every message in it. Both workers used to read
// that as "all 100 of these failed", so a single malformed address could
// silently cost 99 unrelated people their email — permanently, in the campaign
// worker's case, which has no retry.
//
// So a batch error is no longer a verdict on the batch. It's a signal to find
// out WHICH message is bad, by sending them individually. Only the genuinely
// broken one fails; everything else goes out.
//
// The fallback is bounded. If the first few individual sends also fail, this is
// an outage (auth, rate limit, Resend down), not a poison pill — hammering the
// API 100 more times helps nobody, so the rest are reported failed with the
// same error and left to the caller's normal retry path.
// ---------------------------------------------------------------------------

import { logError, logWarn } from "@/lib/observability/logger";

/** Consecutive individual failures that mean "outage", not "one bad message". */
const OUTAGE_STREAK = 3;

/** Minimal shape of the Resend client this module needs — keeps it mockable. */
export interface BatchSender {
  batch: { send: (messages: never) => Promise<{ error?: unknown }> };
  emails: { send: (message: never) => Promise<{ error?: unknown }> };
}

export interface OutboundMessage<K> {
  /** Whatever the caller needs to map the outcome back to its rows. */
  key: K;
  message: Record<string, unknown>;
}

export interface BatchOutcome<K> {
  sent: K[];
  failed: { key: K; error: string }[];
}

function errorText(error: unknown): string {
  if (!error) return "Unknown send error";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Send every message, reporting per-message outcomes.
 *
 * Fast path is one batch call. Only a batch-level error costs extra requests,
 * and it buys the ability to blame the right message.
 */
export async function sendEmailBatch<K>(
  resend: BatchSender,
  messages: OutboundMessage<K>[],
): Promise<BatchOutcome<K>> {
  if (messages.length === 0) return { sent: [], failed: [] };

  let batchError: string | null = null;
  try {
    const { error } = await resend.batch.send(
      messages.map((m) => m.message) as never,
    );
    if (!error) return { sent: messages.map((m) => m.key), failed: [] };
    batchError = errorText(error);
  } catch (error) {
    batchError = errorText(error);
  }

  // A single message can't be poisoning anything — no point re-sending it.
  if (messages.length === 1) {
    return { sent: [], failed: [{ key: messages[0].key, error: batchError }] };
  }

  logWarn("email: batch send failed, retrying individually", {
    count: messages.length,
    error: batchError,
  });

  const sent: K[] = [];
  const failed: { key: K; error: string }[] = [];
  let streak = 0;

  for (let i = 0; i < messages.length; i++) {
    if (streak >= OUTAGE_STREAK) {
      // Treat the remainder as collateral of an outage rather than probing on.
      for (const rest of messages.slice(i)) {
        failed.push({ key: rest.key, error: batchError });
      }
      logError("email: individual sends failing in a row, stopping", {
        after: i,
        error: batchError,
      });
      break;
    }

    const { key, message } = messages[i];
    try {
      const { error } = await resend.emails.send(message as never);
      if (error) {
        failed.push({ key, error: errorText(error) });
        streak++;
      } else {
        sent.push(key);
        streak = 0;
      }
    } catch (error) {
      failed.push({ key, error: errorText(error) });
      streak++;
    }
  }

  return { sent, failed };
}
