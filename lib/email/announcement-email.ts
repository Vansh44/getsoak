import "server-only";

import { emailButton, emailShell } from "./shell";
import { sanitizeBlogContent } from "@/lib/sanitize";
import type { StoreBrand } from "@/lib/store/brand";

// ---------------------------------------------------------------------------
// The announcement email.
//
// ── ★ IT IS PLATFORM MAIL, SO IT WEARS STOREMINK'S IDENTITY ───────────────
// Not the merchant's. A brand-coloured "here is a new feature" from the
// merchant's own logo would read as their store mailing them, which is exactly
// the confusion that gets a message reported as spam.
//
// ── ★ THE BODY IS SANITIZED AT RENDER, not only at save ───────────────────
// The blog trust model (§11): an operator writing HTML is trusted-ish, but the
// stored value has to survive being re-rendered years later by code that has
// no idea what validation it passed. `sanitizeBlogContent` is the same
// function the storefront's rich-text section uses.
//
// ── ★ AND IT ALWAYS CARRIES A REASON LINE ─────────────────────────────────
// "You're getting this because you own a store on StoreMink" is the difference
// between correspondence and spam, and it is what makes an opt-out link
// meaningful. Feature mail additionally links to where the preference lives;
// operational mail says plainly that it is not opt-out-able, rather than
// offering an unsubscribe that would be a lie.
// ---------------------------------------------------------------------------

export interface AnnouncementEmailInput {
  brand: StoreBrand;
  subject: string;
  /** Operator-authored HTML. Sanitized here regardless of what was stored. */
  bodyHtml: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  category: "feature" | "operational";
  /** Where product-update preferences live. */
  preferencesUrl: string;
  recipientName?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A safe absolute http(s) URL, or null. */
function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function renderAnnouncementEmail(input: AnnouncementEmailInput): {
  subject: string;
  html: string;
} {
  const greeting = input.recipientName?.trim()
    ? `<p class="email-lead">Hi ${escapeHtml(input.recipientName.trim())},</p>`
    : "";

  const cta = safeUrl(input.ctaUrl);
  const button =
    cta && input.ctaLabel?.trim()
      ? emailButton(cta, input.ctaLabel.trim())
      : "";

  const reason =
    input.category === "feature"
      ? `You're receiving this because you opted in to product updates from StoreMink. <a href="${escapeHtml(input.preferencesUrl)}">Change what you get emailed about</a>.`
      : // No unsubscribe offered, deliberately: this is service correspondence
        // about an account they hold, and a link that does not switch it off
        // would be a lie.
        `You're receiving this because you have a StoreMink account. This is a service notice about your store, not marketing.`;

  const html = emailShell({
    brand: input.brand,
    preheader: input.subject,
    bodyHtml: `${greeting}${sanitizeBlogContent(input.bodyHtml)}${button}`,
    footerHtml: `<p class="email-note">${reason}</p>`,
  });

  return { subject: input.subject, html };
}
