import "server-only";

// ---------------------------------------------------------------------------
// THE send choke point. Every email leaves through here.
//
// Before this existed there were eight independent `resend.emails.send` calls,
// each with its own error handling and none of them recorded anywhere. "Did my
// customer get their order confirmation?" had no answer short of reading server
// logs, and OTP mail left no trace at all.
//
// So: one function, and a CI test (send-coverage.test.ts) that fails if a new
// `resend.emails.send` appears outside this file. Logging you have to remember
// to call is logging that will be missing exactly when you need it.
//
// Three rules, in order:
//
//  1. SENDING MUST NOT THROW INTO THE CALLER. Mail is a side effect of somebody
//     else's action — a signup, a checkout, an invite. A provider outage must
//     degrade to "no email", never to a failed order.
//  2. THE LOG IS WRITTEN EITHER WAY. A failed send is the row you most want to
//     see; recording only successes would make the page a liar.
//  3. LOGGING FAILURES ARE SWALLOWED. If the log write fails, the email has
//     still gone out and the caller must not hear about it.
// ---------------------------------------------------------------------------

import { Resend } from "resend";
import { withService } from "@/lib/db/client";
import { emailLogs } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { isSensitiveMailer, REDACTED, type MailerKey } from "./mailers";
import { findSuppressed, normalizeEmail } from "./suppression";

/** Bodies above this are pointless to store and expensive to read back. */
const MAX_LOGGED_BODY = 256 * 1024;

export interface SendEmailInput {
  /** Which store this belongs to. NULL/omitted = platform mail. */
  storeId?: string | null;
  to: string;
  from: string;
  subject: string;
  html: string;
  cc?: string[];
  bcc?: string[];
  /** What KIND of mail this is — see lib/email/mailers.ts. */
  mailer: MailerKey;
  /**
   * Skip the suppression check. Only for mail where a bounce is not a reason to
   * stop — an operator's own sign-in code, say, where the person is standing
   * there waiting for it.
   */
  ignoreSuppression?: boolean;
}

export interface SendEmailResult {
  sent: boolean;
  /** Set when the send did not happen or did not succeed. */
  error?: string;
  /** True when we deliberately didn't try (suppressed address, no API key). */
  skipped?: boolean;
}

/**
 * Is outbound email configured at all? A cheap probe for callers that want to
 * fail fast in the UI ("you can't send a campaign yet") rather than queue work
 * that can't go anywhere. Deliberately not a Resend client — building one just
 * to null-check it is what made senders look like senders when they weren't.
 */
export function emailConfigured(): boolean {
  const apiKey = process.env.RESEND_API_KEY;
  return Boolean(apiKey) && !apiKey!.includes("placeholder");
}

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.includes("placeholder")) return null;
  return new Resend(apiKey);
}

/**
 * Send one email and record it in the store's email log.
 *
 * Never throws. Returns whether it went out, so a caller that wants to tell the
 * user ("we've emailed you a code") can be honest about it.
 */
export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const resend = getResend();
  if (!resend) {
    // Dev/staging without a key: log the intent so the flow is still traceable,
    // and be explicit that nothing was sent rather than reporting success.
    await writeLog(input, {
      status: "skipped",
      error: "RESEND_API_KEY not configured",
    });
    return { sent: false, skipped: true, error: "Email is not configured." };
  }

  if (!input.ignoreSuppression) {
    const suppressed = await findSuppressed([input.to]);
    if (suppressed.has(normalizeEmail(input.to))) {
      await writeLog(input, {
        status: "skipped",
        error: "Address suppressed after a permanent bounce or spam complaint",
      });
      return {
        sent: false,
        skipped: true,
        error: "That address can no longer receive email.",
      };
    }
  }

  try {
    const { data, error } = await resend.emails.send({
      from: input.from,
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      subject: input.subject,
      html: input.html,
    });

    if (error) {
      const message = error.message ?? String(error);
      await writeLog(input, { status: "failed", error: message });
      return { sent: false, error: message };
    }

    await writeLog(input, {
      status: "sent",
      providerMessageId: data?.id ?? null,
    });
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeLog(input, { status: "failed", error: message });
    return { sent: false, error: message };
  }
}

export interface LogOnlyInput {
  storeId?: string | null;
  to: string;
  from: string;
  subject: string;
  html?: string | null;
  cc?: string[];
  bcc?: string[];
  mailer: MailerKey;
  status: "sent" | "failed" | "skipped";
  error?: string | null;
  providerMessageId?: string | null;
}

/**
 * Record a send that happened somewhere this module can't wrap — specifically
 * the two BATCH workers, which hand Resend up to 100 messages at once and can't
 * route through the single-message path without losing that.
 *
 * Same redaction and the same swallowing; only the transport differs.
 */
export async function logEmail(input: LogOnlyInput): Promise<void> {
  await writeLog(
    {
      storeId: input.storeId,
      to: input.to,
      from: input.from,
      subject: input.subject,
      html: input.html ?? "",
      cc: input.cc,
      bcc: input.bcc,
      mailer: input.mailer,
    },
    {
      status: input.status,
      error: input.error ?? undefined,
      providerMessageId: input.providerMessageId ?? null,
    },
  );
}

async function writeLog(
  input: Pick<
    SendEmailInput,
    "storeId" | "to" | "from" | "subject" | "html" | "cc" | "bcc" | "mailer"
  >,
  outcome: {
    status: "sent" | "failed" | "skipped";
    error?: string;
    providerMessageId?: string | null;
  },
): Promise<void> {
  // Sensitive credentials must not outlive their expiry inside a log table
  // that store staff can read. The catalog owns the documented operator-only
  // OTP exceptions (see lib/email/mailers.ts). Everything a log is actually
  // for — who, when, did it send — survives redaction untouched.
  const sensitive = isSensitiveMailer(input.mailer);
  const body = sensitive ? null : input.html;

  try {
    await withService((db) =>
      db.insert(emailLogs).values({
        storeId: input.storeId ?? null,
        toEmail: input.to.slice(0, 320),
        fromEmail: input.from.slice(0, 320),
        cc: input.cc?.length ? input.cc.join(", ").slice(0, 1000) : null,
        bcc: input.bcc?.length ? input.bcc.join(", ").slice(0, 1000) : null,
        subject: sensitive ? REDACTED : input.subject.slice(0, 500),
        mailer: input.mailer,
        provider: "resend",
        status: outcome.status,
        error: outcome.error?.slice(0, 500) ?? null,
        providerMessageId: outcome.providerMessageId ?? null,
        bodyHtml: body && body.length <= MAX_LOGGED_BODY ? body : null,
      }),
    );
  } catch (error) {
    // Rule 3: the mail has already gone. A log failure is ours, not the
    // caller's, and must never surface as a failed send.
    logError("email log write failed", error, { mailer: input.mailer });
  }
}
