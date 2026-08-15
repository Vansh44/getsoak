import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { loadSmsSender, loadSmsTemplates } from "./channel";
import { renderDltBody } from "./dlt";
import { sendSms } from "./send";
import { isSuppressed } from "./suppression";

// ---------------------------------------------------------------------------
// Draining notification_sms_queue. The `lib/email/notification-worker.ts` shape.
//
// ── ★★ AN UNKNOWN OUTCOME IS NOT RETRIED ───────────────────────────────────
// This is where the client's three-way outcome earns its keep. `rejected` is a
// verdict from the provider — a bad number, an unregistered header — and
// retrying it just repeats a refusal. `unknown` is a timeout or a 5xx, where
// the message MAY HAVE GONE, and retrying it sends somebody the same text
// twice. An SMS is a phone buzzing in someone's pocket; a duplicate is worse
// than a miss.
//
// So only a rejection is ever retried, and only because the message provably
// did not go. §26 states this rule for refunds; the reasoning is identical and
// the cost of getting it wrong is just cheaper here.
// ---------------------------------------------------------------------------

/** 5 / 15 / 45 minutes, matching the email worker's backoff. */
const BACKOFF_MINUTES = [5, 15, 45];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;
const BATCH = 50;

export interface SmsWorkerResult {
  claimed: number;
  sent: number;
  failed: number;
  /** Sends whose outcome the provider never confirmed. Never retried. */
  unknown: number;
  skipped: number;
}

/**
 * Claim and send one batch.
 *
 * Returns `claimed` so the caller can decide whether to chain — the cron does,
 * like the email one, so a backlog drains rather than waiting a day per batch.
 */
export async function runSmsWorker(): Promise<SmsWorkerResult> {
  const result: SmsWorkerResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
  };

  // ★ FOR UPDATE SKIP LOCKED, the email queue's pattern: two overlapping runs
  // take different rows rather than both sending the same message.
  const claimed = await withService(async (db) => {
    const rows = await db.execute(sql`
      update public.notification_sms_queue q
         set status = 'sending', attempts = attempts + 1
       where q.id in (
         select id from public.notification_sms_queue
          where status = 'pending'
            and next_attempt_at <= now()
          order by created_at
          limit ${BATCH}
          for update skip locked
       )
      returning q.id, q.store_id, q.recipient_id, q.recipient_type, q.phone,
                q.event_key, q.values, q.attempts
    `);
    return asRows(rows) as QueueRow[];
  }).catch((err) => {
    logError("sms worker: claim failed", err);
    return [] as QueueRow[];
  });

  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  // Sender and templates are per STORE, and a batch is usually one or two —
  // so they are resolved once per store rather than once per message.
  const senders = new Map<string, Awaited<ReturnType<typeof loadSmsSender>>>();
  const templateSets = new Map<
    string,
    Awaited<ReturnType<typeof loadSmsTemplates>>
  >();

  for (const row of claimed) {
    const storeId = row.store_id;
    if (!storeId) {
      await settle(row.id, "failed", "No store on the queued message.");
      result.failed++;
      continue;
    }

    // ★ OPT-OUT IS CHECKED AT SEND, NOT AT ENQUEUE. Someone can text STOP
    // between an order being placed and the queue draining, and the message
    // that arrives after they opted out is the one that gets a complaint.
    if (await isSuppressed(storeId, row.phone)) {
      await settle(row.id, "failed", "Recipient has opted out of SMS.");
      result.skipped++;
      continue;
    }

    if (!senders.has(storeId)) {
      senders.set(
        storeId,
        await withService((db) => loadSmsSender(db, storeId)),
      );
    }
    const sender = senders.get(storeId);
    if (!sender) {
      // Disconnected or paused since this was queued. Not retryable: the
      // merchant made that choice, and it is not going to resolve itself.
      await settle(row.id, "failed", "SMS is not connected for this store.");
      result.failed++;
      continue;
    }

    const tKey = `${storeId}:${row.event_key}`;
    if (!templateSets.has(tKey)) {
      templateSets.set(
        tKey,
        await withService((db) => loadSmsTemplates(db, storeId, row.event_key)),
      );
    }
    const template = templateSets
      .get(tKey)
      ?.get(row.recipient_type === "customer" ? "customer" : "team");
    if (!template) {
      await settle(row.id, "failed", "No DLT template for this notification.");
      result.failed++;
      continue;
    }

    // Re-rendered from the SNAPSHOTTED values, so the message says what it
    // said when the event happened — but against the CURRENT template, so a
    // merchant who fixed a mistyped mirror gets the fix rather than the
    // version that was already wrong.
    const rendered = renderDltBody(
      { templateId: template.dltTemplateId, body: template.body },
      Array.isArray(row.values) ? row.values.map(String) : [],
    );
    if (!rendered.ok) {
      await settle(row.id, "failed", rendered.error);
      result.failed++;
      continue;
    }

    const out = await sendSms({
      storeId,
      to: toE164(row.phone),
      body: rendered.body,
      creds: sender.creds,
      senderHeader: sender.senderHeader,
      dltEntityId: sender.dltEntityId,
      dltTemplateId: template.dltTemplateId,
      eventKey: row.event_key,
    });

    if (out.sent) {
      await settle(row.id, "sent");
      result.sent++;
      continue;
    }

    if (out.outcome === "unknown") {
      // ★ TERMINAL, deliberately. The message may have gone; sending it again
      // to find out is the one thing that cannot be undone.
      await settle(row.id, "failed", `Unconfirmed: ${out.error}`);
      result.unknown++;
      continue;
    }

    if (out.outcome === "skipped") {
      await settle(row.id, "failed", out.error);
      result.skipped++;
      continue;
    }

    // A rejection provably did not send, so it is the only retryable case.
    if (row.attempts < MAX_ATTEMPTS) {
      await requeue(row.id, row.attempts, out.error);
    } else {
      await settle(row.id, "failed", out.error);
    }
    result.failed++;
  }

  logInfo("sms worker ran", { ...result });
  return result;
}

async function settle(
  id: string,
  status: "sent" | "failed",
  error?: string,
): Promise<void> {
  try {
    await withService((db) =>
      db.execute(sql`
        update public.notification_sms_queue
           set status = ${status},
               error = ${error ?? null},
               sent_at = ${status === "sent" ? sql`now()` : sql`null`}
         where id = ${id}::uuid
      `),
    );
  } catch (err) {
    // The message went; only the bookkeeping failed. Logged rather than
    // retried, because a retry here would re-SEND it.
    logError("sms worker: settle failed", err, { id, status });
  }
}

async function requeue(
  id: string,
  attempts: number,
  error: string,
): Promise<void> {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, MAX_ATTEMPTS) - 1] ?? 45;
  try {
    await withService((db) =>
      db.execute(sql`
        update public.notification_sms_queue
           set status = 'pending',
               error = ${error},
               next_attempt_at = now() + (${minutes} || ' minutes')::interval
         where id = ${id}::uuid
      `),
    );
  } catch (err) {
    logError("sms worker: requeue failed", err, { id });
  }
}

/**
 * Indian numbers are stored as ten digits; Twilio requires E.164.
 *
 * A number that already carries a `+` is passed through — a store may have
 * international customers, and mangling their number is worse than sending to
 * one Twilio might reject with a message that names the problem.
 */
function toE164(phone: string): string {
  const raw = (phone ?? "").trim();
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return `+${digits}`;
}

interface QueueRow {
  id: string;
  store_id: string | null;
  recipient_id: string;
  recipient_type: string;
  phone: string;
  event_key: string;
  values: unknown;
  attempts: number;
}

function asRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
}
