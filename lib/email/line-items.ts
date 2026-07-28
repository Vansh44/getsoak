// ---------------------------------------------------------------------------
// The order summary block — what was bought, and what it added up to.
//
// RENDERER CHROME, NOT EDITABLE COPY. It cannot come through the merchant
// template system: template values are escaped strings (that escaping is the
// XSS boundary — see template.ts), so a table would arrive as visible markup.
// It sits between the body and the CTA button, exactly like the button itself.
//
// Everything here is a TABLE with inline styles and explicit widths, because
// that is the only layout Outlook, Gmail's clipping and a 320px phone all
// agree on. No flex, no grid, no <style> block — email clients strip the last
// one and disagree about the first two.
//
// Pure: no DB, no server imports, so the preview and the send are the same code.
// ---------------------------------------------------------------------------

import { EMAIL_FONT, EMAIL_THEME, escapeHtml } from "./shell";
import { formatMoney } from "@/lib/notifications/format";

export interface EmailLineItem {
  name: string;
  variant?: string | null;
  quantity: number;
  /** Line total (price × quantity, net of any per-line discount). */
  total?: number | null;
}

export interface EmailOrderSummary {
  items?: EmailLineItem[];
  currency?: string | null;
  subtotal?: number | null;
  discount?: number | null;
  tax?: number | null;
  shipping?: number | null;
  total?: number | null;
}

/** A summary of forty lines is a wall; the order page has the rest. */
const MAX_ROWS = 20;

const cell = `font-family:${EMAIL_FONT}; font-size:14px; line-height:1.5; color:${EMAIL_THEME.ink};`;
const muted = `font-family:${EMAIL_FONT}; font-size:13px; line-height:1.5; color:${EMAIL_THEME.muted};`;

function money(value: number | null | undefined, currency: string): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? ""
    : formatMoney(value, currency);
}

function itemRow(item: EmailLineItem, currency: string): string {
  const name = escapeHtml(item.name || "Item");
  const variant = item.variant ? escapeHtml(item.variant) : "";
  const qty = Number(item.quantity) || 0;

  return `<tr>
  <td style="${cell} padding:12px 0; border-bottom:1px solid ${EMAIL_THEME.hairline};">
    <span style="font-weight:600;">${name}</span>
    ${variant ? `<br /><span style="${muted}">${variant}</span>` : ""}
    ${qty > 1 ? `<br /><span style="${muted}">Qty ${qty}</span>` : ""}
  </td>
  <td align="right" valign="top" style="${cell} padding:12px 0 12px 12px; border-bottom:1px solid ${EMAIL_THEME.hairline}; white-space:nowrap;">
    ${money(item.total, currency)}
  </td>
</tr>`;
}

/** A totals line. `strong` is the final amount — bigger, darker, with a rule. */
function totalRow(
  label: string,
  value: string,
  opts: { strong?: boolean } = {},
): string {
  if (!value) return "";
  const weight = opts.strong ? "600" : "400";
  const size = opts.strong ? "16px" : "14px";
  const colour = opts.strong ? EMAIL_THEME.ink : EMAIL_THEME.inkSoft;
  const border = opts.strong
    ? `border-top:1px solid ${EMAIL_THEME.border};`
    : "";
  return `<tr>
  <td style="${cell} ${border} padding:${opts.strong ? "12px 0 0" : "5px 0 0"}; font-size:${size}; color:${colour};">${escapeHtml(label)}</td>
  <td align="right" style="${cell} ${border} padding:${opts.strong ? "12px 0 0 12px" : "5px 0 0 12px"}; font-size:${size}; font-weight:${weight}; color:${colour}; white-space:nowrap;">${value}</td>
</tr>`;
}

/**
 * Render the order summary, or "" when there is nothing to show.
 *
 * Returning empty rather than an empty frame matters: this block is attached to
 * every notification email, and only order-shaped ones carry items.
 */
export function renderOrderSummary(summary: EmailOrderSummary | null): string {
  if (!summary) return "";
  const currency = summary.currency || "INR";
  const items = (summary.items ?? []).filter((i) => i && i.name);

  const hasTotals = [
    summary.subtotal,
    summary.discount,
    summary.tax,
    summary.shipping,
    summary.total,
  ].some((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
  if (items.length === 0 && !hasTotals) return "";

  const shown = items.slice(0, MAX_ROWS);
  const hidden = items.length - shown.length;

  const rows = shown.map((i) => itemRow(i, currency)).join("\n");
  const more =
    hidden > 0
      ? `<tr><td colspan="2" style="${muted} padding:10px 0;">+${hidden} more item${hidden === 1 ? "" : "s"}</td></tr>`
      : "";

  // A discount is money coming OFF — shown negative, or it reads as a charge.
  const discount = Number(summary.discount);
  const totals = [
    totalRow("Subtotal", money(summary.subtotal, currency)),
    Number.isFinite(discount) && discount > 0
      ? totalRow("Discount", `−${money(discount, currency)}`)
      : "",
    totalRow("Tax", money(summary.tax, currency)),
    totalRow("Shipping", money(summary.shipping, currency)),
    totalRow("Total", money(summary.total, currency), { strong: true }),
  ]
    .filter(Boolean)
    .join("\n");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:22px 0 0; border-collapse:collapse;">
  <tr>
    <td colspan="2" style="${muted} padding:0 0 4px; text-transform:uppercase; letter-spacing:0.6px; font-size:11px; font-weight:600;">Order summary</td>
  </tr>
  ${rows}
  ${more}
  ${totals}
</table>`;
}
