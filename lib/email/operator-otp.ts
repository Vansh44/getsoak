import "server-only";
import { wrapBrandedEmail } from "./layout";
import { EMAIL_THEME } from "./shell";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
import { sendEmail } from "./send";
import type { StoreBrand } from "@/lib/store/brand";

// A minimal StoreBrand for the platform's own transactional mail (operator
// sign-in codes) — StoreMink itself, sent from the shared verified domain.
const PLATFORM_BRAND: StoreBrand = {
  name: "StoreMink",
  logoUrl: null,
  // Unused by the email shell now (one global palette — see shell.ts);
  // kept because StoreBrand requires it.
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

/**
 * Email a 6-digit operator sign-in code through the platform's Resend domain
 * (proper SPF/DKIM → inbox, not the spam folder the Firebase magic link landed
 * in). Best-effort: when Resend isn't configured it logs the code to the server
 * (so staging can still test the flow) and returns { sent: false } — never
 * throws, so a mail hiccup can't wedge the login action.
 */
export async function sendOperatorOtpEmail(
  to: string,
  code: string,
): Promise<{ sent: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.includes("placeholder")) {
    // Dev / not-yet-configured: surface the code in the logs so the flow is
    // testable without email delivery.
    console.log(
      `📨 [operator otp] Resend not configured — code for ${to}: ${code}`,
    );
    return { sent: false };
  }

  const body = wrapBrandedEmail(
    `<p style="margin:0 0 16px; font-size:16px; color:${EMAIL_THEME.ink};">Your StoreMink admin sign-in code:</p>
     <p style="margin:0 0 8px; font-size:34px; font-weight:700; letter-spacing:8px; color:${EMAIL_THEME.ink}; font-family:'Courier New', monospace;">${code}</p>
     <p style="margin:16px 0 0; font-size:14px; color:${EMAIL_THEME.muted};">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email — no one can sign in without it.</p>`,
    PLATFORM_BRAND,
  );

  // Platform mail: storeId stays null, so this only ever shows on the
  // storemink.com console — never in a merchant's own email log.
  //
  // The code is stored IN FULL there (owner's decision — see the note on the
  // `operator_otp` entry in lib/email/mailers.ts), so a sign-in that "never
  // arrived" can be checked against the log directly.
  //
  // ignoreSuppression: someone is sitting at a login screen waiting for this;
  // a historic bounce is not a reason to withhold it.
  const result = await sendEmail({
    to,
    from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
    subject: `${code} is your StoreMink sign-in code`,
    html: body,
    mailer: "operator_otp",
    ignoreSuppression: true,
  });
  return { sent: result.sent };
}
