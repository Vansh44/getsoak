import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import { wrapBrandedEmail } from "./layout";
import { EMAIL_THEME } from "./shell";
import { PLATFORM_EMAIL_DOMAIN } from "./sender";
import { sendEmail } from "./send";
import type { StoreBrand } from "@/lib/store/brand";
import { withService } from "@/lib/db/client";
import { admins, storeBillingSettings, stores } from "@/drizzle/schema";
import { formatIndianMobile } from "@/lib/phone";

// Transactional BILLING emails. These come from the platform (StoreMink), not
// the merchant's store brand — a plan receipt / renewal / dunning notice is
// from "StoreMink Billing". Built on the same Resend + branded-layout
// primitives as the other notification modules, and best-effort: a mail
// failure never throws into the billing flow.

const BILLING_FROM = `StoreMink Billing <billing@${PLATFORM_EMAIL_DOMAIN}>`;

// A minimal StoreBrand-shaped object so we can reuse wrapBrandedEmail with
// StoreMink's own branding for every billing email.
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(inr: number): string {
  return `₹${inr.toLocaleString("en-IN")}`;
}

function shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

const button = (href: string, label: string) =>
  `<p style="margin:28px 0 8px;"><a href="${href}" style="display:inline-block; background:${EMAIL_THEME.ink}; color:#ffffff; font-weight:600; font-size:15px; text-decoration:none; padding:12px 22px; border-radius:10px;">${label}</a></p>`;

function shell(bodyHtml: string): string {
  return wrapBrandedEmail(
    `${bodyHtml}
    <p style="margin-top:32px; color:${EMAIL_THEME.muted}; font-size:13px;">
      This is an automated message about your StoreMink subscription.<br />
      Questions? Reply to this email and our team will help.
    </p>`,
    PLATFORM_BRAND,
  );
}

// ── Pure template builders (subject + html) — unit-tested ───────────────────

export interface BuiltEmail {
  subject: string;
  html: string;
}

export function planActivatedTemplate(d: {
  storeName: string;
  planName: string;
  amountInr: number;
  period: "monthly" | "yearly";
  renewsOn: string | null;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  return {
    subject: `You're on the ${d.planName} plan`,
    html: shell(
      `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.ink};">Welcome to ${escapeHtml(d.planName)} 🎉</h1>
       <p style="margin:0 0 12px;"><strong>${store}</strong> is now on the <strong>${escapeHtml(d.planName)}</strong> plan at <strong>${money(d.amountInr)}/${d.period === "yearly" ? "year" : "month"}</strong>.</p>
       <p style="margin:0 0 4px;">Autopay is set up, so it renews automatically${d.renewsOn ? ` on <strong>${shortDate(d.renewsOn)}</strong>` : ""}. You can change or cancel your plan anytime.</p>
       ${button(d.manageUrl, "Manage your plan")}`,
    ),
  };
}

export function paymentReceiptTemplate(d: {
  storeName: string;
  planName: string;
  amountInr: number;
  period: "monthly" | "yearly";
  renewsOn: string | null;
  manageUrl: string;
}): BuiltEmail {
  return {
    subject: `Payment received — ${d.planName} plan`,
    html: shell(
      `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.ink};">Payment received</h1>
       <p style="margin:0 0 12px;">We charged <strong>${money(d.amountInr)}</strong> for <strong>${escapeHtml(d.storeName)}</strong>'s ${escapeHtml(d.planName)} plan (${d.period}).</p>
       <p style="margin:0 0 4px;">Your plan is active${d.renewsOn ? ` and renews on <strong>${shortDate(d.renewsOn)}</strong>` : ""}.</p>
       ${button(d.manageUrl, "View billing")}`,
    ),
  };
}

export function paymentFailedTemplate(d: {
  storeName: string;
  planName: string;
  final: boolean;
  accessUntil: string | null;
  manageUrl: string;
}): BuiltEmail {
  return {
    subject: d.final
      ? `Action needed — your ${d.planName} plan is about to end`
      : `We couldn't process your ${d.planName} payment`,
    html: shell(
      d.final
        ? `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.danger};">Your subscription is about to end</h1>
           <p style="margin:0 0 12px;">We couldn't collect payment for <strong>${escapeHtml(d.storeName)}</strong>'s ${escapeHtml(d.planName)} plan after several attempts.</p>
           <p style="margin:0 0 4px;">Please update your payment method to keep your plan${d.accessUntil ? ` — access continues until <strong>${shortDate(d.accessUntil)}</strong>` : ""}, after which the store moves to the Free plan.</p>
           ${button(d.manageUrl, "Update payment method")}`
        : `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.ink};">Payment didn't go through</h1>
           <p style="margin:0 0 12px;">A charge for <strong>${escapeHtml(d.storeName)}</strong>'s ${escapeHtml(d.planName)} plan failed. We'll retry automatically over the next few days.</p>
           <p style="margin:0 0 4px;">To avoid any interruption, please make sure your payment method is up to date.</p>
           ${button(d.manageUrl, "Check billing")}`,
    ),
  };
}

export function subscriptionCancelledTemplate(d: {
  storeName: string;
  planName: string;
  accessUntil: string | null;
  manageUrl: string;
}): BuiltEmail {
  return {
    subject: `Your ${d.planName} subscription is cancelled`,
    html: shell(
      `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.ink};">Subscription cancelled</h1>
       <p style="margin:0 0 12px;">Autopay for <strong>${escapeHtml(d.storeName)}</strong>'s ${escapeHtml(d.planName)} plan is cancelled — no further payments will be taken.</p>
       <p style="margin:0 0 4px;">You keep ${escapeHtml(d.planName)}${d.accessUntil ? ` until <strong>${shortDate(d.accessUntil)}</strong>` : " until the current cycle ends"}, then the store moves to the Free plan. Changed your mind? You can re-subscribe anytime.</p>
       ${button(d.manageUrl, "Re-subscribe")}`,
    ),
  };
}

/**
 * A renewal invoice has been issued for the next cycle.
 *
 * ★★ `autopay` CHANGES WHAT THIS MESSAGE IS, not just its wording. With a
 * mandate it is a courtesy heads-up before a debit the merchant need do nothing
 * about; without one it is a BILL, and doing nothing loses them their plan. Send
 * the wrong variant and a merchant reasonably ignores it and is downgraded —
 * which is why the flag is required rather than defaulted.
 */
export function renewalDueTemplate(d: {
  storeName: string;
  planName: string;
  amountInr: number;
  dueOn: string;
  invoiceRef: string | null;
  autopay: boolean;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const ref = d.invoiceRef
    ? `<p style="margin:0 0 12px; color:${EMAIL_THEME.muted}; font-size:13px;">Invoice ${escapeHtml(d.invoiceRef)}</p>`
    : "";
  return {
    subject: d.autopay
      ? `Your ${d.planName} plan renews on ${shortDate(d.dueOn)}`
      : `${money(d.amountInr)} due for your ${d.planName} plan`,
    html: shell(
      d.autopay
        ? `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.ink};">Your plan renews soon</h1>
           <p style="margin:0 0 12px;"><strong>${store}</strong>'s ${plan} plan renews on <strong>${shortDate(d.dueOn)}</strong>. We'll charge <strong>${money(d.amountInr)}</strong> to your saved payment method — there's nothing you need to do.</p>
           ${ref}
           <p style="margin:0 0 4px;">Want to change or cancel first? You can, any time before then.</p>
           ${button(d.manageUrl, "Manage your plan")}`
        : `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.ink};">Time to renew</h1>
           <p style="margin:0 0 12px;"><strong>${store}</strong>'s ${plan} plan is due for renewal. <strong>${money(d.amountInr)}</strong> is payable by <strong>${shortDate(d.dueOn)}</strong>.</p>
           ${ref}
           <p style="margin:0 0 4px;">Pay from your dashboard in a couple of taps. If it's not paid by the renewal date you'll get 48 hours' grace, then the store moves to the Free plan.</p>
           ${button(d.manageUrl, "Pay now")}`,
    ),
  };
}

/**
 * The cycle turned unpaid — the 48-hour grace clock is running.
 *
 * ★ `attempted` must be truthful. With automatic collection gated, "we couldn't
 * take payment" describes a charge that never happened and sends the merchant
 * to check a card nobody touched.
 */
export function renewalOverdueTemplate(d: {
  storeName: string;
  planName: string;
  accessUntil: string;
  attempted: boolean;
  manageUrl: string;
}): BuiltEmail {
  const store = escapeHtml(d.storeName);
  const plan = escapeHtml(d.planName);
  const deadline = new Date(d.accessUntil).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  return {
    subject: `Payment overdue — ${d.planName} ends in 48 hours`,
    html: shell(
      `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.danger};">Your plan ends in 48 hours</h1>
       <p style="margin:0 0 12px;">${
         d.attempted
           ? `We couldn't collect payment for <strong>${store}</strong>'s ${plan} plan.`
           : `<strong>${store}</strong>'s ${plan} renewal hasn't been paid.`
       }</p>
       <p style="margin:0 0 12px;">Pay by <strong>${deadline}</strong> to keep everything running. After that the store moves to the Free plan — your data is safe, but paid features pause, including the point of sale.</p>
       ${button(d.manageUrl, "Pay now")}`,
    ),
  };
}

export function planDowngradedTemplate(d: {
  storeName: string;
  fromPlanName: string;
  manageUrl: string;
}): BuiltEmail {
  return {
    subject: `Your store is now on the Free plan`,
    html: shell(
      `<h1 style="margin:0 0 12px; font-size:20px; color:${EMAIL_THEME.ink};">Moved to the Free plan</h1>
       <p style="margin:0 0 12px;"><strong>${escapeHtml(d.storeName)}</strong>'s ${escapeHtml(d.fromPlanName)} plan has ended, so the store is now on <strong>Free</strong>.</p>
       <p style="margin:0 0 4px;">Your data is safe — nothing was deleted. Some paid features are paused until you upgrade again.</p>
       ${button(d.manageUrl, "Upgrade again")}`,
    ),
  };
}

// ── Recipient + send (best-effort) ──────────────────────────────────────────

const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "storemink.com")
  .trim()
  .toLowerCase();

/** The Plans & Billing URL for a store, for the email CTA. */
export function manageUrl(slug: string): string {
  return `https://${slug}.${ROOT_DOMAIN}/dashboard/plans`;
}

export interface BillingRecipient {
  email: string;
  /** Present only when the owner has a recurring-charge-capable contact. */
  phone?: string | null;
  storeName: string;
  slug: string;
}

/**
 * The billing contact for a store: its owner (superadmin) admin email, else
 * the invoice contact email. Null when neither is set.
 *
 * ★★ THE PHONE HAS TWO SOURCES, AND READING ONLY THE FIRST BLOCKED EVERY
 * SUBSCRIPTION. `startEnrolment` refuses before Checkout unless it has BOTH an
 * email and a phone (Razorpay's subsequent-charge endpoint needs both), and the
 * only source here was `admins.phone` — which the signup wizard NEVER WROTE.
 * The owner OTP-verifies a number during signup and `createStore` put it in
 * `store_billing_settings.contact_phone` only, so every wizard-created store had
 * `admins.phone = NULL` and answered Subscribe with "We couldn't prepare
 * autopay" forever, without a single Razorpay call being made. Measured on
 * production 2026-09-06: 2 of 3 superadmins had no phone, both with a perfectly
 * good verified number sitting one table away.
 *
 * `createStore` now records the verified number on the admin row too, but the
 * fallback is what fixes the stores that already exist — and the invoice contact
 * phone is the store's OWN stated billing contact, which is exactly the right
 * number for a pre-debit notification.
 *
 * ★ The fallback is VALIDATED (`formatIndianMobile`), the owner's is not: an
 * `admins.phone` was written from a verified Identity Platform identity, while
 * the invoice contact is free text a merchant typed on Taxes & invoices and may
 * be a landline or a placeholder. Handing Razorpay one of those registers a
 * mandate whose pre-debit notice reaches nobody.
 */
export async function resolveBillingEmail(
  storeId: string,
): Promise<BillingRecipient | null> {
  let store: { name: string; slug: string } | undefined;
  let ownerEmail: string | null = null;
  let ownerPhone: string | null = null;
  let billingEmail: string | null = null;
  let billingPhone: string | null = null;
  try {
    ({ store, ownerEmail, ownerPhone, billingEmail, billingPhone } =
      await withService(async (db) => {
        const [storeRows, ownerRows, billingRows] = await Promise.all([
          db
            .select({ name: stores.name, slug: stores.slug })
            .from(stores)
            .where(eq(stores.id, storeId))
            .limit(1),
          db
            .select({ email: admins.email, phone: admins.phone })
            .from(admins)
            .where(
              and(
                eq(admins.storeId, storeId),
                eq(admins.role, "superadmin"),
                isNotNull(admins.email),
              ),
            )
            .limit(1),
          db
            .select({
              contact_email: storeBillingSettings.contactEmail,
              contact_phone: storeBillingSettings.contactPhone,
            })
            .from(storeBillingSettings)
            .where(eq(storeBillingSettings.storeId, storeId))
            .limit(1),
        ]);
        return {
          store: storeRows[0],
          ownerEmail: ownerRows[0]?.email ?? null,
          ownerPhone: ownerRows[0]?.phone ?? null,
          billingEmail: billingRows[0]?.contact_email ?? null,
          billingPhone: billingRows[0]?.contact_phone ?? null,
        };
      }));
  } catch (err) {
    console.error(
      "resolveBillingEmail:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const email = ownerEmail || billingEmail || null;
  if (!email) return null;
  // The owner's own verified number belongs to the owner's email; pairing it
  // with an invoice contact email would mix two identities. The store's stated
  // invoice contact phone pairs with either.
  const verifiedOwnerPhone = ownerEmail === email ? ownerPhone : null;
  return {
    email,
    phone: verifiedOwnerPhone || formatIndianMobile(billingPhone),
    storeName: store?.name || "Your store",
    slug: store?.slug || "",
  };
}

/**
 * Send a built billing email to a recipient. Best-effort — never throws.
 *
 * `storeId` is optional only because some callers have the recipient before
 * they have the store; pass it whenever you can, or the send lands in the
 * platform log instead of the merchant's own.
 */
export async function sendBillingEmail(
  to: string,
  built: BuiltEmail,
  storeId?: string | null,
): Promise<void> {
  await sendEmail({
    storeId: storeId ?? null,
    to,
    from: BILLING_FROM,
    subject: built.subject,
    html: built.html,
    mailer: "billing",
  });
}
