import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { smsLogs } from "@/drizzle/schema";
import { smsSegments } from "./dlt";
import { twilioSendSms, type TwilioCreds } from "./twilio";

// ---------------------------------------------------------------------------
// ★★ THE CHOKE POINT. Every SMS this platform sends leaves through `sendSms`,
// and every attempt lands in `sms_logs` — sent, failed or skipped alike.
//
// This is the §24 rule for email applied to the second channel, and it is worth
// restating why: before `lib/email/send.ts` existed there were EIGHT scattered
// `resend.emails.send` calls and none of them recorded anything, so "did the
// customer get it?" had no answer. A second channel with the same shape is how
// that happens twice. `sms-send-coverage.test.ts` fails if a direct
// `twilioSendSms` call appears anywhere but here.
//
// ── ★ IT NEVER THROWS INTO ITS CALLER ──────────────────────────────────────
// The callers are a queue worker and, eventually, a till. A messaging failure
// must not fail the thing that triggered it.
// ---------------------------------------------------------------------------

export interface SendSmsInput {
  storeId: string;
  /** E.164, already normalised by the caller. */
  to: string;
  body: string;
  creds: TwilioCreds;
  senderHeader: string;
  dltEntityId: string;
  dltTemplateId: string;
  /** Which notification this was, for the log's "what was this?" column. */
  eventKey?: string | null;
}

export type SendSmsResult =
  | { sent: true; messageId: string; segments: number }
  | { sent: false; outcome: "rejected" | "unknown" | "skipped"; error: string };

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const segments = smsSegments(input.body);

  // Nothing to send is a `skipped` row, not silence — a merchant asking why a
  // customer heard nothing needs to find the reason in the log, not an absence.
  if (!input.body.trim()) {
    await writeLog(input, { status: "skipped", segments: 0 }, "Empty body.");
    return { sent: false, outcome: "skipped", error: "Nothing to send." };
  }
  if (!input.to) {
    await writeLog(input, { status: "skipped", segments }, "No phone number.");
    return { sent: false, outcome: "skipped", error: "No phone number." };
  }

  const result = await twilioSendSms({
    creds: input.creds,
    to: input.to,
    from: input.senderHeader,
    body: input.body,
    dlt: { entityId: input.dltEntityId, templateId: input.dltTemplateId },
  });

  if (result.ok) {
    await writeLog(input, {
      status: "sent",
      segments,
      messageId: result.messageId,
    });
    return { sent: true, messageId: result.messageId, segments };
  }

  // ★ AN UNKNOWN OUTCOME IS LOGGED AS FAILED BUT REPORTED AS UNKNOWN. The log
  // records that nothing was confirmed; the CALLER needs the distinction,
  // because retrying an `unknown` may send the same message twice.
  await writeLog(input, { status: "failed", segments }, result.error);
  return { sent: false, outcome: result.outcome, error: result.error };
}

async function writeLog(
  input: SendSmsInput,
  meta: { status: string; segments: number; messageId?: string },
  error?: string,
): Promise<void> {
  try {
    await withService((db) =>
      db.insert(smsLogs).values({
        storeId: input.storeId,
        toPhone: input.to || "(none)",
        senderHeader: input.senderHeader || null,
        eventKey: input.eventKey ?? null,
        // ⚠ The body IS stored, unlike a credential-bearing email (§24's
        // `sensitive` mailers). A DLT template is pre-approved fixed text plus
        // order details — the same facts an order row already shows any member
        // of staff — so there is no secret in it to redact.
        body: input.body || null,
        segments: meta.segments,
        status: meta.status,
        error: error ?? null,
        providerMessageId: meta.messageId ?? null,
        dltTemplateId: input.dltTemplateId || null,
      } as typeof smsLogs.$inferInsert),
    );
  } catch (err) {
    // A log failure must not turn a delivered message into a reported failure.
    logError("sms: log write failed", err, { storeId: input.storeId });
  }
}

/**
 * What a store has sent recently — the read behind /dashboard/logs/sms-logs.
 * Store-scoped by the caller's own gate, never by caller input.
 */
export async function listSmsLogs(
  storeId: string,
  opts: { limit?: number; status?: string } = {},
): Promise<
  {
    id: string;
    to_phone: string;
    event_key: string | null;
    segments: number;
    status: string;
    error: string | null;
    created_at: string;
  }[]
> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  try {
    const rows = await withService((db) =>
      db.execute(sql`
        select id, to_phone, event_key, segments, status, error, created_at
          from public.sms_logs
         where store_id = ${storeId}::uuid
           ${opts.status ? sql`and status = ${opts.status}` : sql``}
         order by created_at desc
         limit ${limit}
      `),
    );
    const list = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: unknown[] })?.rows ?? []);
    return list as never;
  } catch (err) {
    logError("sms: log read failed", err, { storeId });
    return [];
  }
}
