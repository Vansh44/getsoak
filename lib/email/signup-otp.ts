import "server-only";

import { wrapBrandedEmail } from "./layout";
import { EMAIL_THEME } from "./shell";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
import { logEmail, sendEmail } from "./send";
import type { StoreBrand } from "@/lib/store/brand";

const PLATFORM_BRAND: StoreBrand = {
  name: "StoreMink",
  logoUrl: null,
  primaryColor: "#202223",
  tagline: null,
  blurb: null,
  legalName: "StoreMink",
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: PLATFORM_EMAIL_DOMAIN,
};

/** RFC-reserved domains are safe dummy identities and never have real inboxes. */
function isReservedTestAddress(email: string): boolean {
  const domain = email.split("@").at(-1)?.toLowerCase();
  if (!domain) return false;
  return (
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost")
  );
}

export interface SignupOtpDelivery {
  sent: boolean;
  /** The code exists only in the operator log because this is a dummy address. */
  operatorLogOnly: boolean;
  error?: string;
}

/** Send a merchant signup code and always record it as platform mail. */
export async function sendSignupOtpEmail(
  to: string,
  code: string,
): Promise<SignupOtpDelivery> {
  const body = wrapBrandedEmail(
    `<p style="margin:0 0 16px; font-size:16px; color:${EMAIL_THEME.ink};">Verify your email to continue creating your StoreMink store.</p>
     <p style="margin:0 0 8px; font-size:34px; font-weight:700; letter-spacing:8px; color:${EMAIL_THEME.ink}; font-family:'Courier New', monospace;">${code}</p>
     <p style="margin:16px 0 0; font-size:14px; color:${EMAIL_THEME.muted};">This code expires in 10 minutes. If you didn't start a StoreMink signup, you can safely ignore this email.</p>`,
    PLATFORM_BRAND,
  );
  const subject = `${code} is your StoreMink verification code`;

  // Reserved example domains are specifically for documentation/testing and
  // cannot receive mail. Recording instead of calling Resend makes dummy-store
  // creation deterministic while keeping the code behind the operator gate.
  if (isReservedTestAddress(to)) {
    await logEmail({
      to,
      from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
      subject,
      html: body,
      mailer: "signup_test_otp",
      status: "skipped",
      error: "Reserved test address — retrieve the code from the operator log",
    });
    return { sent: false, operatorLogOnly: true };
  }

  const result = await sendEmail({
    to,
    from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
    subject,
    html: body,
    mailer: "signup_otp",
    ignoreSuppression: true,
  });
  return {
    sent: result.sent,
    operatorLogOnly: false,
    error: result.error,
  };
}
