import "server-only";

import { logError } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// Twilio, over plain fetch — the `lib/payments/razorpay.ts` shape, and for the
// same reasons: no SDK to keep current, no surprise dependency in the bundle,
// and every request shape visible in one file.
//
// ── ★ THE OUTCOME VOCABULARY IS THE POINT ──────────────────────────────────
// A send has THREE outcomes, not two. `rejected` is a verdict (the provider
// looked at it and said no — a bad number, an unregistered header); `unknown`
// is a timeout, a 5xx or a thrown request, where the message may well have
// gone. Collapsing them is what makes a retry send someone the same message
// twice, so the caller is given the distinction and decides. Same rule §26
// states for refunds.
// ---------------------------------------------------------------------------

const API = "https://api.twilio.com/2010-04-01";

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

export type TwilioResult =
  | { ok: true; messageId: string; status: string }
  | { ok: false; outcome: "rejected" | "unknown"; error: string };

export interface TwilioSendInput {
  creds: TwilioCreds;
  /** E.164. Twilio rejects anything else outright. */
  to: string;
  /** The DLT-registered sender header — the merchant's own identity. */
  from: string;
  body: string;
  /** India-only DLT metadata, sent on every message to an Indian number. */
  dlt?: { entityId: string; templateId: string };
}

export async function twilioSendSms(
  input: TwilioSendInput,
): Promise<TwilioResult> {
  const form = new URLSearchParams({
    To: input.to,
    From: input.from,
    Body: input.body,
  });
  if (input.dlt) {
    // Twilio passes these through to the Indian carriers, which reject the
    // message without them.
    form.set("DltEntityId", input.dlt.entityId);
    form.set("DltTemplateId", input.dlt.templateId);
  }

  let res: Response;
  try {
    res = await fetch(
      `${API}/Accounts/${encodeURIComponent(input.creds.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: basicAuth(input.creds),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );
  } catch (err) {
    // Never reached the provider, or never heard back. The message may exist.
    logError("twilio: request failed", err, { to: redact(input.to) });
    return { ok: false, outcome: "unknown", error: "Couldn't reach Twilio." };
  }

  // ★ A 5xx IS NOT A REJECTION. Retrying one is safe only because it never got
  // a verdict; retrying a 4xx would repeat a request already refused.
  if (res.status >= 500) {
    return { ok: false, outcome: "unknown", error: `Twilio ${res.status}.` };
  }

  const payload = (await res.json().catch(() => null)) as {
    sid?: string;
    status?: string;
    message?: string;
    code?: number;
  } | null;

  if (!res.ok) {
    return {
      ok: false,
      outcome: "rejected",
      // Twilio's own message names the actual problem ("is not a valid phone
      // number", "not a registered sender"), which is far more use to a
      // merchant than anything generic we could substitute.
      error: payload?.message
        ? `${payload.message}${payload.code ? ` (${payload.code})` : ""}`
        : `Twilio rejected the message (${res.status}).`,
    };
  }

  if (!payload?.sid) {
    // 2xx with nothing to identify the message by. We cannot say it failed.
    return {
      ok: false,
      outcome: "unknown",
      error: "Twilio sent no message id.",
    };
  }

  return {
    ok: true,
    messageId: payload.sid,
    status: payload.status ?? "queued",
  };
}

/**
 * Do these credentials work?
 *
 * ★ IT FETCHES THE ACCOUNT, IT DOES NOT SEND. Verifying by sending would cost
 * the merchant a message and put a test SMS on somebody's phone. A 401 here is
 * the whole answer.
 */
export async function twilioVerifyCreds(
  creds: TwilioCreds,
): Promise<{ ok: true; friendlyName: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(
      `${API}/Accounts/${encodeURIComponent(creds.accountSid)}.json`,
      { headers: { Authorization: basicAuth(creds) } },
    );
  } catch {
    return { ok: false, error: "Couldn't reach Twilio. Try again." };
  }

  if (res.status === 401) {
    return { ok: false, error: "Twilio rejected that Account SID and token." };
  }
  if (!res.ok) {
    return { ok: false, error: `Twilio answered ${res.status}.` };
  }

  const payload = (await res.json().catch(() => null)) as {
    friendly_name?: string;
    status?: string;
  } | null;

  // A suspended account authenticates perfectly and delivers nothing, so
  // "the credentials are right" is not the same as "this will work".
  if (payload?.status && payload.status !== "active") {
    return {
      ok: false,
      error: `That Twilio account is ${payload.status}, so it cannot send.`,
    };
  }

  return { ok: true, friendlyName: payload?.friendly_name ?? "Twilio account" };
}

function basicAuth(creds: TwilioCreds): string {
  const raw = `${creds.accountSid}:${creds.authToken}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** Never put a full customer number in a log line. */
function redact(phone: string): string {
  return phone.length > 4 ? `…${phone.slice(-4)}` : "…";
}
