// ---------------------------------------------------------------------------
// The email design system — ONE look for every email StoreMink sends.
//
// ══ WHY ONE GLOBAL DESIGN ═════════════════════════════════════════════════
// Every store email uses the same neutral foundation: white card on light grey,
// near-black text and the store logo/name. Callers may opt into ONE accent via
// `accentColor`; notification mail derives it with `emailAccentColor`, which
// darkens light merchant colours until white CTA text remains accessible.
// Other mail types stay neutral unless they deliberately adopt that contract.
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

function normalizeHex(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw
      .slice(1)
      .split("")
      .map((char) => char + char)
      .join("")}`.toLowerCase();
  }
  return null;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16),
  ) as [number, number, number];
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

function darken(hex: string, amount: number): string {
  return `#${rgb(hex)
    .map((channel) =>
      Math.round(channel * (1 - amount))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Use the merchant's storefront colour without ever putting white CTA text on
 * an unreadably light background. Light colours are progressively darkened,
 * preserving the hue; malformed values fall back to the neutral ink colour.
 */
export function emailAccentColor(brand: StoreBrand): string {
  const original = normalizeHex(brand.primaryColor);
  if (!original) return EMAIL_THEME.button;
  if (contrastWithWhite(original) >= 4.5) return original;
  for (let amount = 0.08; amount <= 0.72; amount += 0.08) {
    const candidate = darken(original, amount);
    if (contrastWithWhite(candidate) >= 4.5) return candidate;
  }
  return EMAIL_THEME.button;
}

// ── Style inlining ─────────────────────────────────────────────────────────
// Email clients strip <style>, so the supported tags get their styles inlined.
// A small vocabulary on purpose: someone editing an email body should be
// writing paragraphs, headings, lists and links — not a layout.
const TAG_STYLES: Record<string, string> = {
  p: `margin:0 0 14px; font-family:${EMAIL_FONT}; font-size:15px; line-height:1.62; color:${EMAIL_THEME.inkSoft};`,
  h2: `margin:26px 0 10px; font-family:${EMAIL_FONT}; font-size:16px; font-weight:600; color:${EMAIL_THEME.ink};`,
  h3: `margin:22px 0 8px; font-family:${EMAIL_FONT}; font-size:14.5px; font-weight:600; color:${EMAIL_THEME.ink};`,
  ul: `margin:0 0 16px 20px; padding:0;`,
  ol: `margin:0 0 16px 20px; padding:0; font-family:${EMAIL_FONT}; font-size:15px; color:${EMAIL_THEME.inkSoft};`,
  li: `margin:0 0 8px; font-family:${EMAIL_FONT}; font-size:14.5px; line-height:1.55; color:${EMAIL_THEME.inkSoft};`,
  strong: `color:${EMAIL_THEME.ink}; font-weight:600;`,
  a: `color:${EMAIL_THEME.ink}; text-decoration:underline;`,
  hr: `border:none; border-top:1px solid ${EMAIL_THEME.border}; margin:22px 0;`,
};

const CLASS_STYLES: Record<string, string> = {
  "email-lead": `margin:0 0 20px; font-family:${EMAIL_FONT}; font-size:16px; line-height:1.65; color:${EMAIL_THEME.inkSoft};`,
  "email-details": `margin:20px 0; padding:0; list-style:none; background-color:${EMAIL_THEME.panel}; border:1px solid ${EMAIL_THEME.border}; border-radius:10px; overflow:hidden;`,
  "email-detail": `margin:0; padding:12px 16px; border-bottom:1px solid ${EMAIL_THEME.hairline}; font-family:${EMAIL_FONT}; font-size:14.5px; line-height:1.5; color:${EMAIL_THEME.ink};`,
  "email-label": `color:${EMAIL_THEME.muted}; font-family:${EMAIL_FONT}; font-size:10.5px; line-height:1.4; font-weight:600; letter-spacing:0.65px; text-transform:uppercase;`,
  "email-code": `margin:0 0 10px; padding:17px 18px; background-color:${EMAIL_THEME.panel}; border:1px solid ${EMAIL_THEME.border}; border-radius:10px; font-family:'Courier New', monospace; font-size:28px; line-height:1.2; font-weight:700; letter-spacing:3px; text-align:center; color:${EMAIL_THEME.ink};`,
  "email-note": `margin:0 0 14px; font-family:${EMAIL_FONT}; font-size:13.5px; line-height:1.6; color:${EMAIL_THEME.muted};`,
};

/**
 * Inline styles for the supported tags. Tags that already carry a `style`
 * attribute are left alone, so anyone who wants to override something can.
 */
export function inlineEmailStyles(html: string, accent?: string): string {
  let out = html.replace(
    /<([a-z0-9]+)(\s[^>]*)?>/gi,
    (match, tag: string, attrs: string | undefined) => {
      if (!attrs || /\sstyle\s*=/i.test(attrs)) return match;
      const classes = attrs.match(/\sclass=["']([^"']+)["']/i)?.[1];
      if (!classes) return match;
      const style = classes
        .split(/\s+/)
        .map((name) => CLASS_STYLES[name])
        .filter(Boolean)
        .join(" ");
      return style ? `<${tag}${attrs} style="${style}">` : match;
    },
  );
  for (const [tag, style] of Object.entries(TAG_STYLES)) {
    const tagStyle =
      tag === "a" && normalizeHex(accent)
        ? style.replace(EMAIL_THEME.ink, normalizeHex(accent)!)
        : style;
    out = out.replace(
      new RegExp(`<${tag}(\\s[^>]*)?>`, "gi"),
      (match, attrs: string | undefined) => {
        if (attrs && /\sstyle\s*=/i.test(attrs)) return match;
        return `<${tag}${attrs ?? ""} style="${tagStyle}">`;
      },
    );
  }
  return out;
}

/** One high-contrast CTA. Notification mail may pass its safe brand accent. */
export function emailButton(
  href: string,
  label: string,
  background: string = EMAIL_THEME.button,
): string {
  const colour = normalizeHex(background) ?? EMAIL_THEME.button;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px;">
  <tr>
    <td bgcolor="${colour}" style="background-color:${colour}; border-radius:7px;">
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
  /** Optional safe accent for the card edge. */
  accentColor?: string;
  /** The line an inbox shows next to the subject. Without it, clients grab
   *  whatever markup comes first. */
  preheader?: string;
}): string {
  const { brand, bodyHtml, footerHtml, preheader } = opts;
  const accent = normalizeHex(opts.accentColor);

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
    <style>
      @media only screen and (max-width: 620px) {
        .sm-email-page-pad { padding: 20px 8px !important; }
        .sm-email-header { padding: 0 12px 16px !important; }
        .sm-email-card { padding: 26px 20px !important; border-radius: 10px !important; }
        .sm-email-footer { padding: 16px 12px 0 !important; }
      }
    </style>
  </head>
  <body bgcolor="${EMAIL_THEME.page}" style="margin:0; padding:0; background-color:${EMAIL_THEME.page}; -webkit-font-smoothing:antialiased;">
    ${
      preheader
        ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(preheader)}</div>`
        : ""
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_THEME.page}" style="background-color:${EMAIL_THEME.page};">
      <tr>
        <td class="sm-email-page-pad" align="center" style="padding:36px 12px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px;">
            <tr>
              <td class="sm-email-header" style="padding:0 6px 18px;">
                ${header}
              </td>
            </tr>
            <tr>
              <td class="sm-email-card" bgcolor="${EMAIL_THEME.card}" style="background-color:${EMAIL_THEME.card}; border:1px solid ${EMAIL_THEME.border}; ${accent ? `border-top:4px solid ${accent}; ` : ""}border-radius:14px; padding:36px 34px;">
                ${bodyHtml}
              </td>
            </tr>
            ${
              footerHtml
                ? `<tr>
              <td class="sm-email-footer" style="padding:18px 8px 0;">
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
