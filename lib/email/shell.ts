// ---------------------------------------------------------------------------
// The email design system — ONE look for every email StoreMink sends.
//
// ══ WHY ONE GLOBAL DESIGN ═════════════════════════════════════════════════
// Every store's email uses the SAME neutral palette: white card on light grey,
// near-black text, one dark button. The only per-store elements are the LOGO
// and the STORE NAME.
//
// The storefront accent is deliberately NOT used. Pushed into an email it has
// to survive colour-managed clients, forced dark mode, and a button that must
// stay legible at ANY hue a merchant might pick — and when it fails, a customer
// receives something that looks broken. Shopify's transactional mail is
// near-monochrome for the same reason. Identity comes from the logo.
//
// Every email type goes through here: notifications (notification-emails.ts),
// coupon campaigns, blog/enquiry/billing/OTP (via wrapBrandedEmail in
// layout.ts). Change the look once, and it changes everywhere.
// ---------------------------------------------------------------------------

import type { StoreBrand } from "@/lib/store/brand";

/**
 * Escape a value before interpolating it into email HTML.
 *
 * Lives here, at the bottom of the email layer, because everything above needs
 * it — it used to live in coupon-campaign.ts, which made the shell import from
 * a specific email type and would have been a cycle once that type imported
 * the shell. `coupon-campaign` re-exports it so existing callers are unchanged.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The one palette. Deliberately not derived from the store. */
export const EMAIL_THEME = {
  page: "#f6f6f7",
  card: "#ffffff",
  border: "#e1e3e5",
  hairline: "#f1f2f3",
  /** A quiet inset panel (a voucher box, a quoted message). */
  panel: "#fafbfb",
  ink: "#202223",
  inkSoft: "#42474c",
  muted: "#6d7175",
  button: "#202223",
  buttonText: "#ffffff",
  danger: "#8e1f0b",
} as const;

export const EMAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ── Style inlining ─────────────────────────────────────────────────────────
// Email clients strip <style>, so the supported tags get their styles inlined.
// A small vocabulary on purpose: someone editing an email body should be
// writing paragraphs, headings, lists and links — not a layout.
const TAG_STYLES: Record<string, string> = {
  p: `margin:0 0 14px; font-family:${EMAIL_FONT}; font-size:15px; line-height:1.62; color:${EMAIL_THEME.inkSoft};`,
  h2: `margin:26px 0 10px; font-family:${EMAIL_FONT}; font-size:16px; font-weight:600; color:${EMAIL_THEME.ink};`,
  h3: `margin:22px 0 8px; font-family:${EMAIL_FONT}; font-size:14.5px; font-weight:600; color:${EMAIL_THEME.ink};`,
  ul: `margin:0 0 16px; padding:0; list-style:none;`,
  ol: `margin:0 0 16px 20px; padding:0; font-family:${EMAIL_FONT}; font-size:15px; color:${EMAIL_THEME.inkSoft};`,
  li: `padding:9px 0; border-bottom:1px solid ${EMAIL_THEME.hairline}; font-family:${EMAIL_FONT}; font-size:14.5px; line-height:1.5; color:${EMAIL_THEME.inkSoft};`,
  strong: `color:${EMAIL_THEME.muted}; font-weight:400;`,
  a: `color:${EMAIL_THEME.ink}; text-decoration:underline;`,
  hr: `border:none; border-top:1px solid ${EMAIL_THEME.border}; margin:22px 0;`,
};

/**
 * Inline styles for the supported tags. Tags that already carry a `style`
 * attribute are left alone, so anyone who wants to override something can.
 */
export function inlineEmailStyles(html: string): string {
  let out = html;
  for (const [tag, style] of Object.entries(TAG_STYLES)) {
    out = out.replace(
      new RegExp(`<${tag}(\\s[^>]*)?>`, "gi"),
      (match, attrs: string | undefined) => {
        if (attrs && /\sstyle\s*=/i.test(attrs)) return match;
        return `<${tag}${attrs ?? ""} style="${style}">`;
      },
    );
  }
  return out;
}

/** The one button. Dark, legible on white, identical in every email. */
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px;">
  <tr>
    <td bgcolor="${EMAIL_THEME.button}" style="background-color:${EMAIL_THEME.button}; border-radius:6px;">
      <a href="${escapeHtml(href)}" style="display:inline-block; padding:12px 24px; font-family:${EMAIL_FONT}; font-size:14px; font-weight:600; color:${EMAIL_THEME.buttonText}; text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/** A heading in the email's own voice — use at the top of a body. */
export function emailHeading(text: string): string {
  return `<h1 style="margin:0 0 18px; font-family:${EMAIL_FONT}; font-size:22px; line-height:1.3; font-weight:700; letter-spacing:-0.3px; color:${EMAIL_THEME.ink};">${escapeHtml(text)}</h1>`;
}

/**
 * The shell: light page, store logo, white card, optional footer.
 *
 * Forces a light colour scheme — the `color-scheme` meta plus `bgcolor`
 * attributes stop clients inverting a white card to black and taking the text
 * with it. (Aggressive forced-dark clients can still override; a known limit
 * of email, not of this code.)
 */
export function emailShell(opts: {
  brand: StoreBrand;
  bodyHtml: string;
  footerHtml?: string;
  /** The line an inbox shows next to the subject. Without it, clients grab
   *  whatever markup comes first. */
  preheader?: string;
}): string {
  const { brand, bodyHtml, footerHtml, preheader } = opts;

  const header = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" width="132" style="display:block; width:132px; max-width:56%; height:auto;" />`
    : `<div style="font-family:${EMAIL_FONT}; font-size:18px; font-weight:700; letter-spacing:-0.2px; color:${EMAIL_THEME.ink};">${escapeHtml(brand.name)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light only" />
  </head>
  <body bgcolor="${EMAIL_THEME.page}" style="margin:0; padding:0; background-color:${EMAIL_THEME.page}; -webkit-font-smoothing:antialiased;">
    ${
      preheader
        ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(preheader)}</div>`
        : ""
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_THEME.page}" style="background-color:${EMAIL_THEME.page};">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px;">
            <tr>
              <td style="padding:0 4px 18px;">
                ${header}
              </td>
            </tr>
            <tr>
              <td bgcolor="${EMAIL_THEME.card}" style="background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border}; border-radius:12px; padding:32px 30px;">
                ${bodyHtml}
              </td>
            </tr>
            ${
              footerHtml
                ? `<tr>
              <td style="padding:18px 6px 0;">
                ${footerHtml}
              </td>
            </tr>`
                : ""
            }
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** The standard copyright line, for emails with no more specific footer. */
export function emailFooter(brand: StoreBrand, extraHtml?: string): string {
  return `${extraHtml ?? ""}
<p style="margin:${extraHtml ? "8px" : "0"} 0 0; font-family:${EMAIL_FONT}; font-size:12px; color:${EMAIL_THEME.muted};">
  © ${new Date().getFullYear()} ${escapeHtml(brand.legalName || brand.name)}
</p>`;
}
