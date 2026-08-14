// ---------------------------------------------------------------------------
// Notification email templates — the second delivery channel for the event
// spine (CODEBASE.md §24).
//
// ══ ONE GLOBAL DESIGN, SAFELY BRANDED ══════════════════════════════════════
// Every store's notification email uses the same neutral foundation: white
// card, near-black text, restrained borders. Identity comes from the logo/name
// and ONE safe version of the store accent on the card edge, links and CTA.
// `emailAccentColor` darkens light accents until white button text reaches WCAG
// AA contrast; malformed colours fall back to neutral ink.
//
// Other email types use the `wrapBrandedEmail` adapter in lib/email/layout.ts.
// They share the shell but do not opt into notification-specific accent chrome.
//
// Bodies are HTML written by the merchant (or our default), with {{tokens}}
// substituted and every value escaped: they are DB-derived names going into
// markup. `inlineEmailStyles` then inlines styles for the small tag vocabulary
// we support, because email clients ignore <style> blocks.
// ---------------------------------------------------------------------------

import type { StoreBrand } from "@/lib/store/brand";
import { brandFromSettings } from "@/lib/store/brand";
import { PLATFORM_EMAIL_DOMAIN } from "@/lib/email/sender";
import {
  EMAIL_FONT,
  EMAIL_THEME,
  emailAccentColor,
  emailButton,
  emailFooter,
  emailHeading,
  emailShell,
  escapeHtml,
  inlineEmailStyles,
} from "@/lib/email/shell";

// Re-exported: lib/notifications/template.test.ts and callers reach for it here.
export { inlineEmailStyles } from "@/lib/email/shell";
import type { Digest } from "@/lib/notifications/events";
import {
  renderOrderSummary,
  type EmailOrderSummary,
} from "@/lib/email/line-items";

export interface NotificationEmailItem {
  /** Event key drives the action label; optional for legacy queue fixtures. */
  eventKey?: string | null;
  title: string;
  /** HTML body (already substituted), or plain text for legacy callers. */
  body: string | null;
  /** App-relative path ("/dashboard/orders?q=…"), absolutised against baseUrl. */
  url: string | null;
  severity: string;
  createdAt?: string | null;
  /** Order summary, when the event carried one. Renderer chrome — see
   *  lib/email/line-items.ts for why it can't come through the template. */
  summary?: EmailOrderSummary | null;
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

/** The "why am I getting this" footer. Team mail gets the preferences link;
 *  customer mail doesn't (it's transactional — there's nothing to switch off). */
function footer(brand: StoreBrand, baseUrl: string, isTeam: boolean): string {
  const href = `${baseUrl.replace(/\/+$/, "")}/dashboard/settings/notifications`;
  const reason = isTeam
    ? `You're receiving this because you have notifications turned on for ${escapeHtml(brand.name)}. <a href="${escapeHtml(href)}" style="color:${EMAIL_THEME.muted};">Change what you get emailed about</a>.`
    : `You're receiving this because of your order with ${escapeHtml(brand.name)}.`;

  return `<p style="margin:0; font-family:${EMAIL_FONT}; font-size:12px; line-height:1.6; color:${EMAIL_THEME.muted};">
  ${reason}
</p>`;
}

const CUSTOMER_ACTIONS: Record<string, string> = {
  "order.ready_for_pickup": "View collection details",
  "order.pickup_expiring": "View collection details",
  "order.return_approved": "View return",
  "order.return_rejected": "View return",
  "order.exchange_ready": "Track replacement order",
  "blog.approved": "Read your post",
  "blog.rejected": "View your submissions",
};

const TEAM_ACTIONS: Record<string, string> = {
  "order.cancellation_requested": "Review cancellation",
  "order.payment_failed": "Review payment",
  "order.return_requested": "Review return",
  "inventory.low_stock": "Manage inventory",
  "inventory.out_of_stock": "Manage inventory",
  "enquiry.received": "Read enquiry",
  "blog.submitted": "Review post",
  "subscription.payment_failed": "Update billing",
};

function actionLabel(item: NotificationEmailItem, isTeam: boolean): string {
  const key = item.eventKey ?? "";
  if (isTeam) return TEAM_ACTIONS[key] ?? "View in dashboard";
  if (CUSTOMER_ACTIONS[key]) return CUSTOMER_ACTIONS[key];
  return key.startsWith("order.") || item.url?.startsWith("/orders")
    ? "View your order"
    : "View details";
}

/**
 * One event, one email — the "instant" digest setting.
 *
 * `item.body` is HTML (our default template or the merchant's). Values were
 * already escaped during substitution; the template itself is sanitised at save.
 */
export function renderNotificationEmail(opts: {
  item: NotificationEmailItem;
  brand: StoreBrand;
  baseUrl: string;
  /** Team mail gets the preferences link in its footer; customer mail doesn't. */
  isTeam?: boolean;
}): RenderedEmail {
  const { item, brand, baseUrl, isTeam = true } = opts;
  const href = absoluteUrl(item.url, baseUrl);
  const accent = emailAccentColor(brand);

  // Order: what happened → what was bought → what to do about it. The summary
  // sits above the button because the button is the exit, not the content.
  const bodyHtml = `
${emailHeading(item.title)}
${inlineEmailStyles(item.body ?? "", accent)}
${renderOrderSummary(item.summary ?? null)}
${href ? emailButton(href, actionLabel(item, isTeam), accent) : ""}`;

  return {
    subject: item.title,
    html: emailShell({
      brand,
      bodyHtml,
      footerHtml: emailFooter(brand, footer(brand, baseUrl, isTeam)),
      accentColor: accent,
      // First line of the body, stripped — what an inbox shows next to the
      // subject. Without it clients grab whatever markup comes first.
      preheader: (item.body ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120),
    }),
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
  isTeam?: boolean;
}): RenderedEmail {
  const { items, brand, baseUrl, digest, isTeam = true } = opts;
  const accent = emailAccentColor(brand);

  const rows = items
    .map((item) => {
      const href = absoluteUrl(item.url, baseUrl);
      const title = escapeHtml(item.title);
      // One line of context per item — a digest is a list, not a stack of
      // full emails.
      const summary = (item.body ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 110);

      return `<tr>
  <td style="padding:15px 0; border-bottom:1px solid ${EMAIL_THEME.hairline};">
    <div style="font-family:${EMAIL_FONT}; font-size:15px; font-weight:600; color:${EMAIL_THEME.ink};">
      ${href ? `<a href="${escapeHtml(href)}" style="color:${accent}; text-decoration:none;">${title}</a>` : title}
    </div>
    ${
      summary
        ? `<div style="margin-top:3px; font-family:${EMAIL_FONT}; font-size:13.5px; line-height:1.55; color:${EMAIL_THEME.muted};">${escapeHtml(summary)}</div>`
        : ""
    }
  </td>
</tr>`;
    })
    .join("\n");

  const window = digest === "hourly" ? "in the last hour" : "since yesterday";
  const dashboardUrl = `${baseUrl.replace(/\/+$/, "")}/dashboard/logs`;

  const bodyHtml = `
<h1 style="margin:0 0 4px; font-family:${EMAIL_FONT}; font-size:22px; line-height:1.3; font-weight:700; letter-spacing:-0.3px; color:${EMAIL_THEME.ink};">
  ${countLabel(items.length)} ${escapeHtml(window)}
</h1>
<p style="margin:0 0 6px; font-family:${EMAIL_FONT}; font-size:14.5px; color:${EMAIL_THEME.muted};">
  Here's what happened in your store.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${rows}
</table>
${emailButton(dashboardUrl, "Open dashboard", accent)}`;

  return {
    subject: `${countLabel(items.length)} from ${brand.name}`,
    html: emailShell({
      brand,
      bodyHtml,
      footerHtml: emailFooter(brand, footer(brand, baseUrl, isTeam)),
      accentColor: accent,
      preheader: `${countLabel(items.length)} ${window}`,
    }),
  };
}
