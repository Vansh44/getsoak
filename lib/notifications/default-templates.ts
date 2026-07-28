// ---------------------------------------------------------------------------
// Default email copy for every notification.
//
// WHY THIS EXISTS: the bell needs one short line ("New order ORD10010004 ·
// ₹1,240"); an email needs a subject, an opening line, the details laid out so
// they can be scanned, and a reason to click. Using the bell's line as an email
// body left the console's Message box looking empty and the mail itself thin.
//
// The copy is TEMPLATE TEXT — the same {{tokens}} a merchant can edit — so what
// the console shows as the placeholder is exactly what would be sent, and
// "customise this" starts from something already good rather than a blank box.
//
// Bodies are built from the event's own declared variables (variables.ts), so a
// new event gets a sensible email for free and no template can reference a
// value its emitter doesn't provide.
//
// Pure module: no DB, no server imports.
// ---------------------------------------------------------------------------

import { getEventDef } from "./events";
import { BASE_VARIABLES, variablesFor } from "./variables";
import { HIDDEN_VARIABLES } from "./format";

/** Which audience the copy is written for. Team and customer read completely
 *  differently — "New order · ₹1,240 · from Priya S." vs "Thanks, we've got
 *  your order" — so the default copy is per audience, not one text reused. */
export type TemplateAudience = "team" | "customer";

const BASE_NAMES = new Set(BASE_VARIABLES.map((v) => v.name));

/**
 * Events whose email carries a rendered order summary (the emitter passes
 * `email:` to emitEvent — see EmitEventInput). For these the table below is the
 * detail, so the fact list must not repeat it.
 */
const HAS_ORDER_SUMMARY = new Set(["order.placed"]);

/** What that table already shows. Still valid {{tokens}} for a merchant who
 *  wants them; simply not repeated in the built-in copy. */
const SUMMARY_OWNED = new Set([
  "items",
  "total",
  "subtotal",
  "discount",
  "tax",
  "shipping",
]);

/** Opening line per event. Falls back to the registry description, which is
 *  already written as a sentence. */
const INTRO: Record<string, string> = {
  "order.placed": "You've received a new order.",
  "order.status_changed": "An order has moved to a new status.",
  "order.cancellation_requested":
    "A customer has asked to cancel an order. It's waiting for your review.",
  "order.cancelled": "An order has been cancelled.",
  "order.payment_received": "A payment has been captured.",
  "order.payment_failed":
    "An online payment didn't go through. The order is still unpaid.",
  "order.refund_issued": "A refund is on its way back to the customer.",
  "inventory.low_stock":
    "One of your items is running low. Restock it before it sells out.",
  "inventory.out_of_stock": "An item has sold out and can no longer be bought.",
  "product.deleted": "A product has been removed from your catalog.",
  "customer.signed_up": "A new customer has created an account on your store.",
  "customer.review_submitted": "A customer has left a review on your product.",
  "enquiry.received": "Someone has sent you a message through your store.",
  "blog.submitted":
    "A customer has submitted a blog post. It's waiting for approval.",
  "blog.published": "A blog post is now live on your storefront.",
  "blog.comment_posted": "Someone has commented on one of your posts.",
  "campaign.sent": "Your email campaign has finished sending.",
  "admin.invited": "A new team member has been invited to your dashboard.",
  "admin.role_changed": "A team member's role has changed.",
  "admin.removed": "A team member no longer has access to your store.",
  "security.password_changed":
    "An account password was changed. If this wasn't you, reset it now.",
  "plan.changed": "Your StoreMink plan has changed.",
  "plan.expiring":
    "Your plan is about to expire. Renew to keep your paid features.",
  "subscription.payment_failed":
    "We couldn't collect your plan payment. Update your payment method to avoid losing paid features.",
  "ai.credits_low": "Your AI generation allowance is nearly used up.",
  "ai.credits_purchased": "Your AI credits have been topped up.",
};

/**
 * Shopper-facing opening lines. Written in the second person and about THEIR
 * order — a customer must never receive the operational phrasing meant for the
 * merchant's team.
 */
const CUSTOMER_INTRO: Record<string, string> = {
  "order.placed":
    "Thanks for your order — we've got it and we're getting it ready.",
  "order.status_changed": "There's an update on your order.",
  "order.cancelled":
    "Your order has been cancelled. If you paid online, your refund is on its way back to your original payment method.",
  "order.refund_issued":
    "Your refund is on its way. Banks usually take 5–7 working days to show it.",
  "blog.approved": "Your post has been approved and is now live.",
  "blog.rejected":
    "Thanks for your submission — it wasn't published this time.",
};

/** Subject-line prefixes a shopper would recognise in their inbox. */
const CUSTOMER_SUBJECT: Record<string, string> = {
  "order.placed": "Your order is confirmed",
  "order.status_changed": "Update on your order",
  "order.cancelled": "Your order was cancelled",
  "order.refund_issued": "Your refund is on its way",
  "blog.approved": "Your post is live",
  "blog.rejected": "About your post",
};

/**
 * Events whose copy is HAND-WRITTEN rather than generated from their variables.
 *
 * The generated shape — an intro, then a Reference/Who/When fact list — is
 * right for a report ("stock is low", "a payment failed") and wrong for
 * anything a person is meant to feel something about. A welcome rendered as a
 * fact list reads like a receipt for having existed.
 *
 * Keep this map small. If an event only needs a better opening line, put it in
 * INTRO; this is for the handful that need a different SHAPE.
 */
const BESPOKE: Record<string, { subject: string; body: string }> = {
  "store.created": {
    subject: "{{subject_label}} is live on StoreMink",
    body: [
      "<p>Your store is ready — here it is:</p>",
      '<p><a href="{{store_url}}">{{store_url}}</a></p>',
      "<p>Three things worth doing next:</p>",
      "<ol>",
      "  <li><strong>Add your first product</strong> so there's something to sell.</li>",
      "  <li><strong>Make it yours</strong> — logo, colours and pages live in the website builder.</li>",
      "  <li><strong>Take a test order</strong> to see the whole flow end to end.</li>",
      "</ol>",
      "<p>Everything is editable later, including the store name and address.</p>",
    ].join("\n"),
  },
};

/** Human label for a variable in the details list ("order_ref" → "Order ref"). */
function labelFor(name: string): string {
  return name
    .split("_")
    .map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export interface DefaultTemplate {
  subject: string;
  /** HTML. The merchant edits this directly; `inlineEmailStyles` in
   *  lib/email/notification-emails.ts styles the supported tags at send time. */
  body: string;
}

/**
 * The built-in email copy for an event, as editable HTML template text.
 *
 * Shape: an opening paragraph, then the event's own facts as a definition list
 * (which the email shell renders as hairline-separated rows), then a closing
 * line. Deliberately a small tag vocabulary — `<p>`, `<ul>/<li>`, `<strong>` —
 * so a merchant can edit it confidently without knowing email HTML.
 *
 * The facts come from the event's declared variables, so a new event gets a
 * sensible email for free and no template can reference a value its emitter
 * doesn't provide.
 */
export function defaultEmailTemplate(
  eventKey: string,
  audience: TemplateAudience = "team",
): DefaultTemplate {
  const def = getEventDef(eventKey);
  const label = def?.label ?? "Notification";
  const isCustomer = audience === "customer";

  // Hand-written copy wins over the generated fact list (see BESPOKE).
  const bespoke = !isCustomer ? BESPOKE[eventKey] : undefined;
  if (bespoke) return bespoke;

  const intro = isCustomer
    ? (CUSTOMER_INTRO[eventKey] ?? "There's an update on your order.")
    : (INTRO[eventKey] ??
      def?.description ??
      "Something happened in your store.");

  // Event-specific facts, in the order the variable catalog declares them.
  //
  // Two things are filtered out. HIDDEN_VARIABLES drops values folded into
  // another — `currency` rides on every amount, so a "Currency: INR" row is the
  // email saying it twice. SUMMARY_OWNED drops the ones the rendered order
  // summary already shows in full (lib/email/line-items.ts): listing "Items:
  // 4 items · Amul Taaza…" and "Total ₹343.00" directly above a table of the
  // same items and the same total is the duplication that makes an email look
  // auto-generated. The fact list keeps what the table doesn't carry —
  // reference, payment method, when.
  const summaryOwned = HAS_ORDER_SUMMARY.has(eventKey)
    ? SUMMARY_OWNED
    : new Set<string>();

  const facts: { label: string; token: string }[] = [
    { label: "Reference", token: "subject_label" },
    ...variablesFor(eventKey)
      .filter(
        (v) =>
          !BASE_NAMES.has(v.name) &&
          !HIDDEN_VARIABLES.has(v.name) &&
          !summaryOwned.has(v.name),
      )
      .map((v) => ({ label: labelFor(v.name), token: v.name })),
    // A shopper knows who they are; the team needs to know who acted.
    ...(isCustomer ? [] : [{ label: "Who", token: "actor_name" }]),
    { label: "When", token: "date" },
  ];

  const rows = facts
    .map((f) => `  <li><strong>${f.label}</strong><br />{{${f.token}}}</li>`)
    .join("\n");

  // No call-to-action here on purpose: renderNotificationEmail already appends
  // a real button (emailButton) from the notification's own url, so putting a
  // link in the editable copy too would give every email two of them.
  const action = isCustomer
    ? `<p>If anything looks wrong, just reply to this email and we'll sort it out.</p>`
    : `<p>Open it in your dashboard to take the next step.</p>`;

  return {
    subject: isCustomer
      ? `${CUSTOMER_SUBJECT[eventKey] ?? label} · {{subject_label}}`
      : `${label}: {{subject_label}}`,
    body: [`<p>${intro}</p>`, "<ul>", rows, "</ul>", action].join("\n"),
  };
}
