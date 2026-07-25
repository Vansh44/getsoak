import "server-only";

// Shared transport for the two POS staff emails (invitation + credential reset).
// Both are branded, best-effort (a send failure must never fail the action), and
// fall back to a console log when Resend isn't configured — otherwise there is
// no way to obtain the link in local development.

import { Resend } from "resend";
import { getStoreBrandById } from "@/lib/store/brand";
import { wrapBrandedEmail } from "@/lib/email/layout";
import { fromAddress } from "@/lib/email/sender";
import { getRequestOrigin } from "@/lib/request-url";
import { getStoreUrl } from "@/lib/site";
import type { StoreBrand } from "@/lib/store/brand";

/** Escape user-supplied values before interpolating into email HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * An absolute URL on the host the CURRENT request is being served from, so
 * emailed links are clickable in local dev, staging and production alike.
 * Falls back to the store's canonical origin outside a request scope.
 */
export async function posAbsoluteUrl(path: string): Promise<string> {
  const origin = (await getRequestOrigin()) ?? (await getStoreUrl());
  return `${origin}${path}`;
}

/** A dark call-to-action button, matching the invite email's styling. */
export function emailButton(href: string, label: string): string {
  return `<div style="text-align:center;margin:32px 0;">
    <a href="${href}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a>
  </div>`;
}

export async function sendPosStaffEmail(opts: {
  storeId: string;
  to: string;
  /** Built with the store's brand so copy can use the store name. */
  build: (brand: StoreBrand) => { subject: string; html: string };
  /** Logged instead when no email provider is configured (dev). */
  devFallback: string;
}): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const available = resendApiKey && !resendApiKey.includes("placeholder");

  if (!available) {
    console.log("\n" + "=".repeat(60));
    console.log(opts.devFallback);
    console.log("=".repeat(60) + "\n");
    return;
  }

  try {
    const brand = await getStoreBrandById(opts.storeId);
    const { subject, html } = opts.build(brand);
    const resend = new Resend(resendApiKey);
    await resend.emails.send({
      // From/Subject are mail headers, NOT HTML — build the From with the
      // RFC-5322-safe helper and leave the brand name unescaped in both.
      from: fromAddress(brand, { suffix: "POS" }),
      to: opts.to,
      subject,
      html: wrapBrandedEmail(html, brand),
    });
  } catch (e) {
    console.error("POS staff email failed:", e);
  }
}
