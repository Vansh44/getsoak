// ---------------------------------------------------------------------------
// Notification email templates — the second delivery channel for the event
// spine (CODEBASE.md §22).
//
// Two shapes, one branded layout:
//   • SINGLE   — one event, one email ("instant" digest).
//   • DIGEST   — everything that landed in one hourly/daily window, grouped
//                into one email. This is the whole point of the digest: a
//                store doing 400 orders a day sends its owner one summary,
//                not 400 emails.
//
// Pure: every function takes the brand and base URL rather than resolving them,
// so the copy is unit-testable without a database or a request. The worker
// (notification-worker.ts) does the resolving.
//
// Titles/bodies are built from DB values (customer names, product names), so
// EVERY interpolation is escaped — the blog/coupon-email trust model.
// ---------------------------------------------------------------------------

import type { StoreBrand } from "@/lib/store/brand";
import { brandFromSettings } from "@/lib/store/brand";
import { escapeHtml } from "@/lib/email/coupon-campaign";
import { wrapBrandedEmail } from "@/lib/email/layout";
import { PLATFORM_EMAIL_DOMAIN } from "@/lib/email/sender";
import type { Digest } from "@/lib/notifications/events";
import { splitBody } from "@/lib/notifications/default-templates";

export interface NotificationEmailItem {
  title: string;
  body: string | null;
  /** App-relative path ("/dashboard/orders?q=…"), absolutised against baseUrl. */
  url: string | null;
  severity: string;
  createdAt?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

/** Brand for PLATFORM-level mail (operator notifications), which belongs to no
 *  store. Built through brandFromSettings so it can never drift from the
 *  StoreBrand shape as fields are added. */
export function platformBrand(): StoreBrand {
  return brandFromSettings(undefined, "StoreMink", PLATFORM_EMAIL_DOMAIN);
}

/** Make an app-relative notification link absolute. Anything already absolute
 *  is passed through; anything that isn't a plain path is dropped, so a bad
 *  stored value can't become a link to somewhere else entirely. */
export function absoluteUrl(
  path: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("/")) return null;
  return `${baseUrl.replace(/\/+$/, "")}${trimmed}`;
}

const SEVERITY_COLOR: Record<string, string> = {
  info: "#0284c7",
  success: "#059669",
  warning: "#d97706",
  critical: "#dc2626",
};

function severityColor(severity: string): string {
  return SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.info;
}

function ctaButton(href: string, label: string, brand: StoreBrand): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
  <tr>
    <td bgcolor="${escapeHtml(brand.primaryColor)}" style="background-color:${escapeHtml(brand.primaryColor)}; border-radius:8px;">
      <a href="${escapeHtml(href)}" style="display:inline-block; padding:12px 22px; font-family:Arial, sans-serif; font-size:14px; font-weight:bold; color:#ffffff; text-decoration:none;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/** The "why am I getting this" footer. Every notification email carries it —
 *  it is both good manners and the thing that stops people marking us spam. */
function preferencesFooter(baseUrl: string): string {
  const href = `${baseUrl.replace(/\/+$/, "")}/dashboard/settings/notifications`;
  return `<p style="margin:28px 0 0; padding-top:16px; border-top:1px solid #f0f0f0; font-family:Arial, sans-serif; font-size:12px; line-height:1.6; color:#8b93a3;">
  You're receiving this because you have notifications turned on for this store.
  <a href="${escapeHtml(href)}" style="color:#8b93a3;">Choose what you get emailed about</a>.
</p>`;
}

/**
 * One event, one email. Used for the "instant" digest setting — the default for
 * the events that genuinely warrant interrupting someone (a new order, a failed
 * payment, a role change).
 */
export function renderNotificationEmail(opts: {
  item: NotificationEmailItem;
  brand: StoreBrand;
  baseUrl: string;
}): RenderedEmail {
  const { item, brand, baseUrl } = opts;
  const href = absoluteUrl(item.url, baseUrl);

  // The body arrives as text: free-form lines plus "Label: value" facts. The
  // facts become a scannable table rather than a paragraph — the layout every
  // good transactional email uses, because the reader is looking for one number.
  const { paragraphs, rows } = splitBody(item.body ?? "");

  const paragraphHtml = paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 12px; font-family:Arial, sans-serif; font-size:15px; line-height:1.6; color:#454b54;">${escapeHtml(text)}</p>`,
    )
    .join("\n");

  const rowsHtml = rows.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0 4px; border:1px solid #ececec; border-radius:8px; border-collapse:separate; overflow:hidden;">
${rows
  .map(
    (row, i) => `  <tr>
    <td style="padding:11px 16px; ${i > 0 ? "border-top:1px solid #f2f2f2;" : ""} font-family:Arial, sans-serif; font-size:13px; color:#8b93a3; white-space:nowrap;">${escapeHtml(row.label)}</td>
    <td align="right" style="padding:11px 16px; ${i > 0 ? "border-top:1px solid #f2f2f2;" : ""} font-family:Arial, sans-serif; font-size:14px; font-weight:bold; color:#17130f;">${escapeHtml(row.value)}</td>
  </tr>`,
  )
  .join("\n")}
</table>`
    : "";

  const body = `
<p style="margin:0 0 8px; font-family:Arial, sans-serif; font-size:11.5px; font-weight:bold; letter-spacing:0.6px; text-transform:uppercase; color:${severityColor(item.severity)};">
  ${escapeHtml(brand.name)}
</p>
<h1 style="margin:0 0 14px; font-family:Arial, sans-serif; font-size:21px; line-height:1.3; color:#17130f;">
  ${escapeHtml(item.title)}
</h1>
${paragraphHtml}
${rowsHtml}
${href ? ctaButton(href, "View in dashboard", brand) : ""}
${preferencesFooter(baseUrl)}`;

  return {
    subject: item.title,
    html: wrapBrandedEmail(body, brand),
  };
}

/** "3 updates" / "1 update" — used in the digest subject and heading. */
function countLabel(n: number): string {
  return `${n} update${n === 1 ? "" : "s"}`;
}

/**
 * Everything from one digest window, in one email. Items arrive newest-first
 * and are rendered as a compact list, each linking to its own destination.
 */
export function renderNotificationDigest(opts: {
  items: NotificationEmailItem[];
  brand: StoreBrand;
  baseUrl: string;
  digest: Digest;
}): RenderedEmail {
  const { items, brand, baseUrl, digest } = opts;

  const rows = items
    .map((item) => {
      const href = absoluteUrl(item.url, baseUrl);
      const title = escapeHtml(item.title);
      return `<tr>
  <td style="padding:14px 0; border-bottom:1px solid #f0f0f0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="10" valign="top" style="padding-top:6px;">
          <div style="width:8px; height:8px; border-radius:50%; background-color:${severityColor(item.severity)};"></div>
        </td>
        <td style="padding-left:12px; font-family:Arial, sans-serif;">
          <div style="font-size:15px; font-weight:bold; color:#17130f;">
            ${href ? `<a href="${escapeHtml(href)}" style="color:#17130f; text-decoration:none;">${title}</a>` : title}
          </div>
          ${
            item.body
              ? `<div style="margin-top:3px; font-size:13.5px; line-height:1.55; color:#5b6472;">${escapeHtml(item.body)}</div>`
              : ""
          }
        </td>
      </tr>
    </table>
  </td>
</tr>`;
    })
    .join("\n");

  const window = digest === "hourly" ? "in the last hour" : "since yesterday";
  const dashboardUrl = `${baseUrl.replace(/\/+$/, "")}/dashboard/activity`;

  const body = `
<p style="margin:0 0 6px; font-family:Arial, sans-serif; font-size:12px; font-weight:bold; letter-spacing:0.4px; text-transform:uppercase; color:#8b93a3;">
  ${escapeHtml(brand.name)}
</p>
<h1 style="margin:0 0 4px; font-family:Arial, sans-serif; font-size:20px; line-height:1.35; color:#17130f;">
  ${countLabel(items.length)} ${escapeHtml(window)}
</h1>
<p style="margin:0 0 8px; font-family:Arial, sans-serif; font-size:14px; color:#8b93a3;">
  Here's what happened in your store.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${rows}
</table>
${ctaButton(dashboardUrl, "Open dashboard", brand)}
${preferencesFooter(baseUrl)}`;

  return {
    subject: `${countLabel(items.length)} from ${brand.name}`,
    html: wrapBrandedEmail(body, brand),
  };
}
