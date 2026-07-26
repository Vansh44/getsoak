import "server-only";
import { Resend } from "resend";
import { wrapBrandedEmail } from "./layout";
import { EMAIL_THEME } from "./shell";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
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

  try {
    const { error } = await new Resend(apiKey).emails.send({
      from: `StoreMink <security@${PLATFORM_EMAIL_DOMAIN}>`,
      to,
      subject: `${code} is your StoreMink sign-in code`,
      html: body,
    });
    if (error) {
      console.error("sendOperatorOtpEmail:", error);
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error("sendOperatorOtpEmail threw:", err);
    return { sent: false };
  }
}
