// ---------------------------------------------------------------------------
// The mailer catalog — every KIND of email this platform sends.
//
// Pure data, in the style of lib/notifications/events.ts and the settings
// registry: one entry per type, and the Email Logs page derives its filter and
// its labels from here rather than hard-coding a list that drifts.
//
// A `mailer` is not a template — it's the ANSWER to "what was this email?" when
// a merchant is looking at a log row six weeks later.
// ---------------------------------------------------------------------------

export const MAILER_KEYS = [
  // Storefront / customer-facing
  "notification",
  "coupon_campaign",
  "enquiry_notification",
  // Team & account
  "staff_invite",
  "password_reset",
  "notification_test",
  "pos_staff_invite",
  "pos_credential_reset",
  // Billing (platform → merchant)
  "billing",
  // Platform security
  "operator_otp",
  "signup_otp",
  "signup_test_otp",
] as const;

export type MailerKey = (typeof MAILER_KEYS)[number];

export interface MailerDef {
  key: MailerKey;
  /** Shown in the log's Mailer column. */
  label: string;
  /** One line of "what is this", for the filter menu. */
  description: string;
  /**
   * True when the message body or subject carries a CREDENTIAL — a one-time
   * code, a password-reset link, an invite token. Those are redacted before the
   * log row is written.
   *
   * The reasoning: an email log is readable by store staff (and, for platform
   * rows, by operators). Storing a live sign-in code there turns a debugging
   * aid into a way to take over an account, and it long outlives the code's own
   * 10-minute expiry. The delivery facts — who, when, did it send — are what a
   * log is for, and redaction keeps all of them.
   */
  sensitive?: boolean;
}

export const MAILERS: MailerDef[] = [
  {
    key: "notification",
    label: "Notification",
    description:
      "Order, inventory and account notifications — the mail configured in Settings → Notifications.",
  },
  {
    key: "coupon_campaign",
    label: "Coupon campaign",
    description: "A marketing send to a customer list.",
  },
  {
    key: "enquiry_notification",
    label: "Enquiry alert",
    description: "Someone submitted the storefront enquiry form.",
  },
  {
    key: "staff_invite",
    label: "Staff invite",
    description: "An invitation for someone to join the dashboard.",
    // Carries a sign-in link that grants dashboard access.
    sensitive: true,
  },
  {
    key: "password_reset",
    label: "Password reset",
    description: "A reset link sent to a team member.",
    // The link IS the credential.
    sensitive: true,
  },
  {
    key: "notification_test",
    label: "Test send",
    description: 'A "send test to me" from the notification editor.',
  },
  {
    key: "pos_staff_invite",
    label: "POS staff invite",
    description:
      "An invitation for a cashier or manager to set up register access.",
    // The registration link is a single-use token that creates their account.
    sensitive: true,
  },
  {
    key: "pos_credential_reset",
    label: "POS credential reset",
    description: "A link for POS staff to set a new PIN or password.",
    // The link IS the authorization — no session is needed to use it.
    sensitive: true,
  },
  {
    key: "billing",
    label: "Billing",
    description:
      "StoreMink plan receipts, renewal failures and downgrade notices.",
  },
  {
    key: "operator_otp",
    label: "Operator sign-in code",
    description: "A one-time code for a StoreMink operator login.",
    // NOT redacted, by owner's decision (2026-07-27) — the code is visible in
    // the log so a sign-in that "never arrived" can be checked directly.
    //
    // What that means, so it's a decision and not an accident: the code appears
    // in the subject and body of a row that any StoreMink OPERATOR can read,
    // for the 90 days the log is kept — long past the code's own 10-minute
    // expiry. It is NOT visible to merchants: operator OTP is platform mail
    // (store_id NULL), so it only ever shows on the storemink.com console, not
    // in any store's log. Setting `sensitive: true` here reverses it.
  },
  {
    key: "signup_otp",
    label: "Signup verification code",
    description:
      "A six-digit code that verifies a new merchant's email address.",
    sensitive: true,
  },
  {
    key: "signup_test_otp",
    label: "Dummy signup code",
    description:
      "A verification code for an RFC-reserved dummy address with no inbox.",
    // Platform-scoped and intentionally retained by the owner's decision
    // (2026-08-12): operators use this to complete dummy-store signups whose
    // reserved test addresses have no inbox. Real-address signup_otp mail is
    // sensitive and redacted; this type never appears in a merchant log and
    // its code expires after 10 minutes.
  },
];

const BY_KEY = new Map(MAILERS.map((m) => [m.key, m]));

export function getMailer(key: string): MailerDef | undefined {
  return BY_KEY.get(key as MailerKey);
}

/** Human label for a stored value, tolerating rows written before a rename. */
export function mailerLabel(key: string): string {
  return BY_KEY.get(key as MailerKey)?.label ?? key;
}

export function isSensitiveMailer(key: string): boolean {
  return BY_KEY.get(key as MailerKey)?.sensitive === true;
}

/** Stored in place of a redacted subject/body, so the row still reads sensibly. */
export const REDACTED = "[redacted — contains a sign-in code or link]";
