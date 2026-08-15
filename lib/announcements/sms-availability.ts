// Can the PLATFORM send an SMS announcement to merchants — and if not, why?
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★ THE ANSWER IS "NO" TODAY, AND MOST OF THE REASON IS NOT CODE.
//
// Three things are missing, and only the first is ours to build:
//
//  1. STOREMINK HAS NO TWILIO ACCOUNT OF ITS OWN. SMS is BYO-per-store (§37):
//     `store_sms_providers` holds a MERCHANT's credentials so they can text
//     THEIR shoppers. Texting merchants is the platform acting as sender, and
//     there is no platform-level equivalent row or env pair.
//
//  2. DLT REGISTRATION. Every commercial SMS to an Indian number requires a
//     registered Principal Entity, a 6-character sender header, and an
//     APPROVED TEMPLATE PER BODY. A message that does not match its template is
//     dropped at the carrier — silently, with no bounce and no error. 7–21
//     business days, on an operator-run portal.
//
//  3. IT IS PROMOTIONAL, NOT TRANSACTIONAL. "Here is a new feature" is not the
//     order-confirmation category §37 already models. Promotional traffic
//     carries its own regime: numeric sender headers, scrubbing against the
//     DND/NDNC preference registers, and time-of-day restrictions. An
//     operational notice ("we are migrating on Sunday") may qualify as
//     service/transactional, but that is a determination to make with the
//     operator, per template — not one to assume in code.
//
// ── ⚠ "BUT I GOT A SIGNUP OTP BY SMS" — YES, AND IT IS NOT A COUNTEREXAMPLE ─
// The signup and set-password screens send a phone OTP through
// `PhoneAuthProvider.verifyPhoneNumber` (§19), which is the FIREBASE WEB SDK
// running in the browser. Google sends that message from its own
// infrastructure, on its own carrier relationships and its own DLT
// registration; the "StoreMink" in the body is the Firebase project's display
// name inside Google's fixed template. No StoreMink server code is in that
// path, nothing reaches `lib/sms/`, and it leaves NO row in `sms_logs`.
//
// It cannot be reused here for two reasons. It is a fixed-purpose verification
// API — there is no parameter for your own copy, only a Google-generated code
// — and it is a TRANSACTIONAL auth message, which is a different regulatory
// category from a promotional announcement no matter who sends it.
//
// ── ★ SO IT REFUSES WITH A REASON RATHER THAN QUEUEING ────────────────────
// The alternative — accept the send and let it fail at the carrier — produces
// no bounce, no error and a log full of rows marked `sent`. §23's rule: a
// control that always fails is worse than no control. This is
// `available: false` in lib/notifications/channels.ts, one level up.
//
// ── ★ AND IT IS A FUNCTION, NOT A CONSTANT ────────────────────────────────
// So that switching it on is configuration, not a code change: set the three
// env values, and every gate below flips together.
// ═══════════════════════════════════════════════════════════════════════════

export interface SmsAvailability {
  available: boolean;
  /** One sentence, shown to the operator at the point they'd choose SMS. */
  reason: string;
  /** What still has to happen, in order. Rendered as a checklist. */
  blockers: string[];
}

/** Env the platform sender needs. All four, or none of it works. */
const ENV_KEYS = [
  "PLATFORM_TWILIO_ACCOUNT_SID",
  "PLATFORM_TWILIO_AUTH_TOKEN",
  "PLATFORM_SMS_SENDER_HEADER",
  "PLATFORM_DLT_ENTITY_ID",
] as const;

export interface PlatformSmsSender {
  accountSid: string;
  authToken: string;
  senderHeader: string;
  dltEntityId: string;
}

/**
 * The platform's own SMS credentials, or null.
 *
 * ⚠ Reads env rather than a database row, unlike a merchant's connection.
 * There is exactly one platform sender and it is infrastructure, not tenant
 * data — the same reasoning that puts the platform's Razorpay keys in env
 * while merchants' live in `store_payment_providers` (§18).
 */
export function platformSmsSender(): PlatformSmsSender | null {
  const accountSid = process.env.PLATFORM_TWILIO_ACCOUNT_SID;
  const authToken = process.env.PLATFORM_TWILIO_AUTH_TOKEN;
  const senderHeader = process.env.PLATFORM_SMS_SENDER_HEADER;
  const dltEntityId = process.env.PLATFORM_DLT_ENTITY_ID;

  if (!accountSid || !authToken || !senderHeader || !dltEntityId) return null;
  return { accountSid, authToken, senderHeader, dltEntityId };
}

/**
 * Whether an SMS announcement can be sent, and what is stopping it.
 *
 * `dltTemplateId` is per-announcement: an approved template covers ONE body,
 * so having a connection is necessary and not sufficient.
 */
export function smsAvailability(
  dltTemplateId?: string | null,
): SmsAvailability {
  const blockers: string[] = [];
  const sender = platformSmsSender();

  if (!sender) {
    const missing = ENV_KEYS.filter((key) => !process.env[key]);
    blockers.push(
      `Connect StoreMink's own Twilio account (missing: ${missing.join(", ")}).`,
    );
    blockers.push(
      "Register a Principal Entity and a 6-character sender header on the DLT portal (7–21 business days).",
    );
  }

  if (!dltTemplateId?.trim()) {
    blockers.push(
      "Register this exact message body as a DLT template and paste its template id. A body that does not match its template is dropped at the carrier, silently.",
    );
  }

  if (blockers.length === 0) {
    return { available: true, reason: "Ready to send.", blockers: [] };
  }

  return {
    available: false,
    reason: sender
      ? "This announcement has no approved DLT template, so carriers would drop it."
      : "StoreMink can't send SMS yet — it has no registered sender of its own.",
    blockers,
  };
}
