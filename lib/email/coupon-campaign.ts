import { wrapBrandedEmail } from "./layout";
import type { StoreBrand } from "@/lib/store/brand";

// escapeHtml moved to lib/email/shell.ts (the bottom of the email layer, so the
// shell can use it without importing a specific email type). Re-exported here
// because plenty of callers already import it from this module.
export { escapeHtml } from "./shell";
import { EMAIL_FONT, EMAIL_THEME, escapeHtml } from "./shell";

/** Merge per-recipient tokens into a subject or body string. */
export function mergeTokens(text: string, firstName: string): string {
  const name = firstName.trim() || "there";
  return text.replace(/\{\{\s*(first_name|name)\s*\}\}/gi, name);
}

export type CouponEmailContent = {
  /** AI- or hand-written body. Plain text; blank lines separate paragraphs.
   *  May contain the {{first_name}} merge tag. */
  body: string;
  /** Recipient's first name used to resolve {{first_name}}. */
  firstName: string;
  code: string;
  discountLabel: string;
  validUntilLabel?: string | null;
  brand: StoreBrand;
};

// Turn the body into safe HTML: escape first (so merged names / copy can't
// inject markup), merge the recipient's name, then split blank-line-separated
// blocks into <p> paragraphs with <br> for single newlines.
function bodyToHtml(body: string, firstName: string): string {
  const merged = mergeTokens(escapeHtml(body), firstName);
  return merged
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map(
      (para) =>
        `<p style="margin:0 0 16px;">${para.replace(/\n/g, "<br />")}</p>`,
    )
    .join("\n");
}

// The shared coupon promo block: a centred box with the code, discount and
// (optionally) the expiry. Rendered by us so every campaign looks consistent
// regardless of what the copy says.
function couponBox(
  code: string,
  discountLabel: string,
  validUntilLabel?: string | null,
): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;">
    <tr>
      <td align="center" style="padding:8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_THEME.panel}; border:1px dashed ${EMAIL_THEME.border}; border-radius:10px;">
          <tr>
            <td align="center" style="padding:20px 32px;">
              <div style="font-family:${EMAIL_FONT}; font-size:12px; color:${EMAIL_THEME.muted}; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px;">${escapeHtml(discountLabel)}</div>
              <div style="font-size:26px; font-weight:700; letter-spacing:2px; color:${EMAIL_THEME.ink}; font-family:'Courier New', monospace;">${escapeHtml(code)}</div>
              ${
                validUntilLabel
                  ? `<div style="font-family:${EMAIL_FONT}; font-size:12px; color:${EMAIL_THEME.muted}; margin-top:8px;">Valid until ${escapeHtml(validUntilLabel)}</div>`
                  : ""
              }
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

/** Inner body HTML (greeting copy + promo box + sign-off), before wrapping. */
export function renderCouponEmailBody(content: CouponEmailContent): string {
  return `${bodyToHtml(content.body, content.firstName)}
${couponBox(content.code, content.discountLabel, content.validUntilLabel)}
<p style="margin-top:28px;">
  Warm regards,<br />
  <strong>Team ${escapeHtml(content.brand.name)}</strong>
</p>`;
}

/** Full, send-ready HTML document for one recipient. */
export function renderCouponEmail(content: CouponEmailContent): string {
  return wrapBrandedEmail(renderCouponEmailBody(content), content.brand);
}
