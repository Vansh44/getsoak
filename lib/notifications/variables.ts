// ---------------------------------------------------------------------------
// Template variables — what a merchant may put in {{curly braces}}.
//
// THE HONEST CONSTRAINT: this list is not aspirational. A variable only appears
// here if an emitter actually provides it, because a merchant who writes
// {{tracking_number}} into a subject line and gets a blank has been misled by
// their own settings page. The per-event lists below are derived from what the
// call sites in app/actions/* pass to emitEvent, and the drift test in
// notifications.test.ts keeps them honest.
//
// Pure module: shared by the template renderer, the console's variable
// palette, and the preview.
// ---------------------------------------------------------------------------

import { EVENTS, type EventKey } from "./events";

export interface TemplateVariable {
  /** The token, without braces: `order_ref` → {{order_ref}} */
  name: string;
  description: string;
  /** Shown in the console's palette and used to render the preview. */
  sample: string;
}

/**
 * Available on EVERY notification: they come from the event envelope
 * (actor/subject/store) rather than any particular payload.
 */
export const BASE_VARIABLES: readonly TemplateVariable[] = [
  {
    name: "store_name",
    description: "Your store's name.",
    sample: "Acme Juice",
  },
  {
    name: "actor_name",
    description: "Who caused this — a customer, a staff member, or 'System'.",
    sample: "Priya S.",
  },
  {
    name: "subject_label",
    description:
      "What it happened to — an order reference, product name, or page title.",
    sample: "ORD10010004",
  },
  {
    name: "event_name",
    description: "The notification's own name, e.g. 'New order'.",
    sample: "New order",
  },
  {
    name: "date",
    description: "When it happened.",
    sample: "26 Jul 2026, 10:32",
  },
  {
    name: "link",
    description: "A link to the relevant page in the dashboard or storefront.",
    sample: "https://acme.storemink.com/dashboard/orders",
  },
];

/**
 * Extra variables per event, from the payload its emitter sends.
 * Keys not listed here are not offered, even if a payload happens to carry them.
 */
const EVENT_VARIABLES: Partial<Record<EventKey, TemplateVariable[]>> = {
  "order.placed": [
    { name: "total", description: "Order total.", sample: "₹1,240.00" },
    { name: "currency", description: "Currency code.", sample: "INR" },
    {
      name: "items",
      description: "What was ordered.",
      sample: "3 items · Amul Taaza Milk, Tata Salt × 2",
    },
    {
      name: "payment_method",
      description: "How the shopper paid.",
      sample: "cod",
    },
    {
      name: "fulfilment",
      description: "Delivery or collection.",
      sample: "pickup",
    },
    {
      name: "pickup_location",
      description: "The shop the order is collected from. Empty for delivery.",
      sample: "Connaught Place",
    },
    {
      name: "pickup_address",
      description: "That shop's address. Empty for delivery.",
      sample: "12 Radial Road, New Delhi",
    },
    {
      name: "ready_on",
      description: "When a collection order will be ready. Empty for delivery.",
      sample: "Ready today",
    },
    {
      name: "delivery_address",
      description: "Where a delivery order is going. Empty for a collection.",
      sample: "hostel D, Thapar University, Patiala, Punjab 147004",
    },
  ],
  "order.ready_for_pickup": [
    {
      name: "pickup_location",
      description: "The shop it's waiting at.",
      sample: "Connaught Place",
    },
    {
      name: "pickup_address",
      description: "That shop's address.",
      sample: "12 Radial Road, New Delhi",
    },
  ],
  "order.collected": [
    {
      name: "pickup_location",
      description: "Where it was handed over.",
      sample: "Connaught Place",
    },
  ],
  "order.pickup_expiring": [
    {
      name: "pickup_location",
      description: "The shop it's waiting at.",
      sample: "Connaught Place",
    },
    {
      name: "pickup_address",
      description: "That shop's address.",
      sample: "12 Radial Road, New Delhi",
    },
    {
      name: "expires_on",
      description: "The collection deadline.",
      sample: "2 August 2026 at 5:50 pm",
    },
    {
      name: "hours_left",
      description: "Hours until the hold lapses.",
      sample: "18",
    },
  ],
  "order.pickup_expired": [
    {
      name: "pickup_location",
      description: "The shop it was waiting at.",
      sample: "Connaught Place",
    },
    {
      name: "refund_due",
      description:
        "Money owed back on a prepaid order nobody collected. Present only when there is any — nothing pays it automatically, by design.",
      sample: "₹1,240.00",
    },
  ],
  "order.status_changed": [
    { name: "status", description: "The new order status.", sample: "shipped" },
    {
      name: "payment_status",
      description: "The new payment status, if it changed.",
      sample: "paid",
    },
  ],
  "order.cancelled": [
    {
      name: "status",
      description: "The new order status.",
      sample: "cancelled",
    },
    {
      name: "reason",
      description: "Cancellation reason, when one was given.",
      sample: "Ordered by mistake",
    },
    {
      name: "refund_due",
      description:
        "Money still owed to the customer. Present only when the order was paid and nothing has been refunded yet — nothing pays it automatically, by design.",
      sample: "₹1,240.00",
    },
  ],
  "order.cancellation_requested": [
    {
      name: "reason",
      description: "Why the customer wants to cancel.",
      sample: "Ordered by mistake",
    },
  ],
  "order.return_requested": [
    {
      name: "items",
      description: "What's coming back.",
      sample: "2 items · Amul Taaza Toned Milk (1 L)",
    },
    {
      name: "reason",
      description: "Why, in the customer's words.",
      sample: "Arrived damaged",
    },
    {
      name: "refund_amount",
      description: "What they'd get back if this is approved, after any fees.",
      sample: "₹840.00",
    },
  ],
  "order.return_approved": [
    {
      name: "refund_amount",
      description: "What the customer gets back, after any fees.",
      sample: "₹840.00",
    },
    {
      name: "fees",
      description:
        "Total deducted. Always ₹0.00 when the return was the store's fault.",
      sample: "₹50.00",
    },
    {
      name: "note",
      description: "Anything the store added for the customer.",
      sample: "Post it back to the address on the invoice.",
    },
  ],
  "order.return_rejected": [
    {
      name: "note",
      description:
        "Why it was declined. The one variable here that really matters — a rejection without it is a silent no.",
      sample: "This item is past its 7-day return window.",
    },
  ],
  "order.exchange_ready": [
    {
      name: "items",
      description: "What's being sent out in exchange.",
      sample: "1 item · Amul Taaza Toned Milk (1 L)",
    },
    {
      name: "exchange_ref",
      description: "The replacement order's reference.",
      sample: "ORD10011031",
    },
    {
      name: "refund_amount",
      description:
        "Any balance owed back when the replacement cost less. Absent on an even swap.",
      sample: "₹150.00",
    },
  ],
  "order.payment_received": [
    { name: "total", description: "Amount captured.", sample: "₹1,240.00" },
  ],
  "order.payment_failed": [
    {
      name: "reason",
      description: "Why the payment failed, when the gateway says.",
      sample: "Card declined",
    },
  ],
  "order.refund_issued": [
    { name: "amount", description: "Amount refunded.", sample: "₹1,240.00" },
  ],
  "inventory.low_stock": [
    { name: "stock", description: "Units left.", sample: "4" },
  ],
  "inventory.out_of_stock": [
    { name: "stock", description: "Units left (zero).", sample: "0" },
  ],
  "customer.review_submitted": [
    { name: "rating", description: "Star rating out of 5.", sample: "5" },
  ],
  "enquiry.received": [
    {
      name: "subject",
      description: "What the enquiry is about.",
      sample: "Bulk order question",
    },
  ],
  "blog.submitted": [
    {
      name: "slug",
      description: "The post's URL slug.",
      sample: "my-first-post",
    },
  ],
  "blog.published": [
    {
      name: "slug",
      description: "The post's URL slug.",
      sample: "my-first-post",
    },
  ],
  "blog.rejected": [
    {
      name: "reason",
      description: "Why it wasn't published.",
      sample: "Needs more detail",
    },
  ],
  "campaign.sent": [
    {
      name: "sent",
      description: "How many recipients it reached.",
      sample: "428",
    },
  ],
  "admin.role_changed": [
    { name: "role", description: "Their new role.", sample: "Manager" },
  ],
  "admin.invited": [
    {
      name: "role",
      description: "The role they were invited as.",
      sample: "Manager",
    },
  ],
  "plan.changed": [
    { name: "plan", description: "The new plan.", sample: "pro" },
    {
      name: "note",
      description: "Any note recorded with the change.",
      sample: "",
    },
  ],
  "plan.expiring": [
    { name: "days_left", description: "Days before it lapses.", sample: "7" },
  ],
  "ai.credits_low": [
    { name: "balance", description: "Generations left.", sample: "3" },
  ],
  "ai.credits_purchased": [
    { name: "credits", description: "Credits added.", sample: "60" },
  ],
  "store.created": [
    {
      name: "store_url",
      description: "The store's public address.",
      sample: "https://acme.storemink.com",
    },
    {
      name: "plan",
      description: "The plan it started on.",
      sample: "free",
    },
  ],
  "platform.store_created": [
    { name: "slug", description: "The new store's subdomain.", sample: "acme" },
    { name: "plan", description: "The plan it signed up on.", sample: "free" },
  ],
  "platform.plan_changed": [
    { name: "plan", description: "The store's new plan.", sample: "pro" },
  ],
  "platform.domain_verified": [
    { name: "domain", description: "The verified domain.", sample: "acme.com" },
  ],
};

/** Every variable a given event's templates may use. */
export function variablesFor(key: string): TemplateVariable[] {
  const extra = EVENT_VARIABLES[key as EventKey] ?? [];
  return [...BASE_VARIABLES, ...extra];
}

/** Fast membership check for the template validator. */
export function variableNamesFor(key: string): Set<string> {
  return new Set(variablesFor(key).map((v) => v.name));
}

/** Sample values for the console's live preview. */
export function sampleValuesFor(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const variable of variablesFor(key))
    out[variable.name] = variable.sample;
  return out;
}

/** Events that expose extra variables beyond the base set — used by tests. */
export function eventsWithVariables(): EventKey[] {
  return EVENTS.map((e) => e.key).filter((key) => EVENT_VARIABLES[key]);
}
