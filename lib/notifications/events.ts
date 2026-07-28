// ---------------------------------------------------------------------------
// Event registry — the single source of truth for everything that can happen
// on StoreMink and who hears about it.
//
// The model has two halves, and keeping them apart is what makes "notify on
// every activity" survivable:
//
//   • EVERY event in this catalog is RECORDED in activity_events. That is the
//     audit trail (/dashboard/activity) — complete by construction.
//   • Only events with a non-empty `audiences` entry are FANNED OUT into
//     someone's inbox. An event with `audiences: {}` is audit-only: visible in
//     the feed, silent in the bell. That is how a busy store gets a full
//     history without 400 unread badges a day.
//
// Adding a notification is therefore ONE entry here: the preferences matrix,
// the routing, and the settings UI all derive from this list — exactly like
// permissions.ts and lib/settings/registry.ts.
//
// Pure module (no server imports) so server actions, the client preference
// editor, and tests can all import it.
// ---------------------------------------------------------------------------

/** Who a notification can be routed to. */
export type Audience = "store-admins" | "customer" | "operators";

/** Delivery channels. Add one here + a column in notification_preferences. */
export type Channel = "inApp" | "email";

export type Severity = "info" | "success" | "warning" | "critical";

/** Email batching. In-app delivery is always instant. */
export type Digest = "instant" | "hourly" | "daily";
export const DIGESTS: readonly Digest[] = ["instant", "hourly", "daily"];

export interface ChannelDefaults {
  inApp: boolean;
  email: boolean;
}

/** Display grouping in the preferences matrix + the activity feed filters. */
export type EventGroup =
  | "Orders"
  | "Inventory"
  | "Catalog"
  | "Customers"
  | "Content"
  | "Marketing"
  | "Team & security"
  | "Plan & billing"
  | "Platform";

export const EVENT_GROUPS: readonly EventGroup[] = [
  "Orders",
  "Inventory",
  "Catalog",
  "Customers",
  "Content",
  "Marketing",
  "Team & security",
  "Plan & billing",
  "Platform",
];

export interface EventDef {
  key: EventKey;
  /** Short label shown in the settings matrix and the feed filter. */
  label: string;
  description: string;
  group: EventGroup;
  /**
   * Dashboard permission section that governs this event (permissions.ts).
   * Doubles as the ROUTING rule for `store-admins`: only admins who may
   * `view` this section are notified, so a blog editor never gets paged about
   * payouts. Deriving recipients from the existing permission map means there
   * is no second recipient config to drift out of sync.
   */
  section: string;
  severity: Severity;
  /**
   * Who is notified, and the default channels per audience. Empty = audit-only
   * (recorded in the feed, no inbox rows).
   */
  audiences: Partial<Record<Audience, ChannelDefaults>>;
  /**
   * False = the merchant cannot switch it off. Reserved for events a store
   * owner must not be able to go blind on (role changes, failed billing,
   * password changes) — the ones that matter in a dispute or a breach.
   * Defaults to true.
   */
  configurable?: boolean;
}

export const EVENT_KEYS = [
  // ── Orders ──────────────────────────────────────────────────────────────
  "order.placed",
  "order.status_changed",
  "order.cancellation_requested",
  "order.cancelled",
  "order.payment_received",
  "order.payment_failed",
  "order.refund_issued",
  // ── Inventory ───────────────────────────────────────────────────────────
  "inventory.low_stock",
  "inventory.out_of_stock",
  "inventory.adjusted",
  // ── Catalog ─────────────────────────────────────────────────────────────
  "product.created",
  "product.updated",
  "product.deleted",
  // ── Customers ───────────────────────────────────────────────────────────
  "customer.signed_up",
  "customer.review_submitted",
  "enquiry.received",
  // ── Content ─────────────────────────────────────────────────────────────
  "blog.submitted",
  "blog.published",
  "blog.approved",
  "blog.rejected",
  "blog.comment_posted",
  "page.published",
  // ── Marketing ───────────────────────────────────────────────────────────
  "coupon.created",
  "campaign.sent",
  // ── Team & security ─────────────────────────────────────────────────────
  "admin.invited",
  "admin.role_changed",
  "admin.removed",
  "security.password_changed",
  "settings.changed",
  "store.created",
  // ── Plan & billing ──────────────────────────────────────────────────────
  "plan.changed",
  "plan.expiring",
  "subscription.payment_failed",
  "ai.credits_low",
  "ai.credits_purchased",
  // ── Platform (store_id IS NULL — StoreMink operators) ───────────────────
  "platform.store_created",
  "platform.store_suspended",
  "platform.plan_changed",
  "platform.domain_verified",
] as const;

export type EventKey = (typeof EVENT_KEYS)[number];

// Channel shorthands, so the catalog below reads as data rather than braces.
const OFF: ChannelDefaults = { inApp: false, email: false };
const IN_APP: ChannelDefaults = { inApp: true, email: false };
const BOTH: ChannelDefaults = { inApp: true, email: true };

export const EVENTS: readonly EventDef[] = [
  // ── Orders ──────────────────────────────────────────────────────────────
  {
    key: "order.placed",
    label: "New order",
    description: "A shopper completed checkout.",
    group: "Orders",
    section: "orders",
    severity: "success",
    audiences: { "store-admins": BOTH, customer: BOTH },
  },
  {
    key: "order.status_changed",
    label: "Order status updated",
    description: "An order moved to processing, shipped, or delivered.",
    group: "Orders",
    section: "orders",
    severity: "info",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.cancellation_requested",
    label: "Cancellation requested",
    description: "A customer asked to cancel an order and is awaiting review.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "order.cancelled",
    label: "Order cancelled",
    description:
      "An order was cancelled by the customer, an admin, or the system.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.payment_received",
    label: "Payment received",
    description: "An online payment was captured for an order.",
    group: "Orders",
    section: "orders",
    severity: "success",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "order.payment_failed",
    label: "Payment failed",
    description: "An online payment failed or was abandoned at checkout.",
    group: "Orders",
    section: "orders",
    severity: "critical",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "order.refund_issued",
    label: "Refund issued",
    description: "A refund was sent back to the customer's payment method.",
    group: "Orders",
    section: "orders",
    severity: "info",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },

  // ── Inventory ───────────────────────────────────────────────────────────
  {
    key: "inventory.low_stock",
    label: "Low stock",
    description: "An item fell to or below its low-stock threshold.",
    group: "Inventory",
    section: "inventory",
    severity: "warning",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "inventory.out_of_stock",
    label: "Out of stock",
    description: "An item sold out and is no longer purchasable.",
    group: "Inventory",
    section: "inventory",
    severity: "critical",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "inventory.adjusted",
    label: "Stock adjusted",
    description: "Stock was changed manually or in bulk. Recorded for audit.",
    group: "Inventory",
    section: "inventory",
    severity: "info",
    audiences: {},
  },

  // ── Catalog ─────────────────────────────────────────────────────────────
  {
    key: "product.created",
    label: "Product created",
    description: "A new product was added to the catalog.",
    group: "Catalog",
    section: "products",
    severity: "info",
    audiences: {},
  },
  {
    key: "product.updated",
    label: "Product updated",
    description: "A product's details, price, or status changed.",
    group: "Catalog",
    section: "products",
    severity: "info",
    audiences: {},
  },
  {
    key: "product.deleted",
    label: "Product deleted",
    description: "A product was removed from the catalog.",
    group: "Catalog",
    section: "products",
    severity: "warning",
    audiences: { "store-admins": IN_APP },
  },

  // ── Customers ───────────────────────────────────────────────────────────
  {
    key: "customer.signed_up",
    label: "New customer",
    description: "A shopper created an account on your storefront.",
    group: "Customers",
    section: "users",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "customer.review_submitted",
    label: "New product review",
    description: "A customer left a review on one of your products.",
    group: "Customers",
    section: "products",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "enquiry.received",
    label: "New enquiry",
    description: "Someone submitted the contact / enquiry form.",
    group: "Customers",
    section: "enquiries",
    severity: "info",
    audiences: { "store-admins": BOTH },
  },

  // ── Content ─────────────────────────────────────────────────────────────
  {
    key: "blog.submitted",
    label: "Blog submitted for review",
    description: "A customer submitted a blog post that needs approval.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "blog.published",
    label: "Blog published",
    description: "A blog post went live on the storefront.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "blog.approved",
    label: "Blog approved",
    description: "A customer's submitted post was approved and published.",
    group: "Content",
    section: "blogs",
    severity: "success",
    audiences: { customer: BOTH },
  },
  {
    key: "blog.rejected",
    label: "Blog rejected",
    description: "A customer's submitted post was declined.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { customer: BOTH },
  },
  {
    key: "blog.comment_posted",
    label: "New blog comment",
    description: "Someone commented on one of your blog posts.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "page.published",
    label: "Page published",
    description: "A page was published from the website builder.",
    group: "Content",
    section: "builder",
    severity: "info",
    audiences: { "store-admins": OFF },
  },

  // ── Marketing ───────────────────────────────────────────────────────────
  {
    key: "coupon.created",
    label: "Coupon created",
    description: "A new discount coupon was created.",
    group: "Marketing",
    section: "marketing",
    severity: "info",
    audiences: {},
  },
  {
    key: "campaign.sent",
    label: "Email campaign sent",
    description: "A coupon email campaign finished sending.",
    group: "Marketing",
    section: "marketing",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },

  // ── Team & security ─────────────────────────────────────────────────────
  {
    key: "admin.invited",
    label: "Team member invited",
    description: "A staff member was invited to this store's dashboard.",
    group: "Team & security",
    section: "admins",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "admin.role_changed",
    label: "Team member's role changed",
    description: "A staff member's role or permissions were changed.",
    group: "Team & security",
    section: "admins",
    severity: "warning",
    audiences: { "store-admins": BOTH },
    // Not switchable: silently changing who can do what is exactly the event
    // an owner must never be able to miss.
    configurable: false,
  },
  {
    key: "admin.removed",
    label: "Team member removed",
    description: "A staff member lost access to this store.",
    group: "Team & security",
    section: "admins",
    severity: "warning",
    audiences: { "store-admins": BOTH },
    configurable: false,
  },
  {
    key: "security.password_changed",
    label: "Password changed",
    description: "An account password was changed or reset.",
    group: "Team & security",
    section: "settings",
    severity: "warning",
    audiences: { "store-admins": BOTH },
    configurable: false,
  },
  {
    key: "settings.changed",
    label: "Store settings changed",
    description: "A store setting or feature toggle was updated.",
    group: "Team & security",
    section: "settings",
    severity: "info",
    audiences: {},
  },

  // ── Plan & billing ──────────────────────────────────────────────────────
  {
    key: "store.created",
    label: "Store created",
    description: "Welcome mail for a merchant who has just finished signup.",
    group: "Team & security",
    section: "settings",
    severity: "success",
    // BOTH, and the ONLY thing that greets a new merchant. Store creation used
    // to emit `platform.store_created` alone — operators, in-app — so the
    // person who had just signed up received nothing at all: no confirmation,
    // no store address, no next step.
    audiences: { "store-admins": BOTH },
    // Not switchable: a merchant cannot have turned this off before they had
    // an account to turn it off in.
    configurable: false,
  },
  {
    key: "plan.changed",
    label: "Plan changed",
    description: "This store moved to a different StoreMink plan.",
    group: "Plan & billing",
    section: "ai",
    severity: "info",
    // IN-APP ONLY, deliberately. StoreMink's own billing sender
    // (lib/email/billing-emails.ts) already mails the merchant from
    // billing@storemink.com with the receipt/activation details — a second
    // mail from the store's own address saying the same thing is noise, and
    // it's platform correspondence, not the store's. Same for the two below.
    audiences: { "store-admins": IN_APP },
    configurable: false,
  },
  {
    key: "plan.expiring",
    label: "Plan expiring soon",
    description: "A timed plan is about to lapse back to Free.",
    group: "Plan & billing",
    section: "ai",
    severity: "warning",
    // The exception to the rule above: nothing else warns BEFORE a plan
    // lapses, so this notification is the only sender and keeps its email.
    audiences: { "store-admins": BOTH },
  },
  {
    key: "subscription.payment_failed",
    label: "Subscription payment failed",
    description: "A recurring plan payment could not be collected.",
    group: "Plan & billing",
    section: "ai",
    severity: "critical",
    // In-app only — paymentFailedTemplate already mails this one.
    audiences: { "store-admins": IN_APP },
    configurable: false,
  },
  {
    key: "ai.credits_low",
    label: "AI credits running low",
    description: "Your AI generation allowance is nearly used up.",
    group: "Plan & billing",
    section: "ai",
    severity: "warning",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "ai.credits_purchased",
    label: "AI credits purchased",
    description: "A credit pack was bought and added to your balance.",
    group: "Plan & billing",
    section: "ai",
    severity: "success",
    audiences: { "store-admins": IN_APP },
  },

  // ── Platform (operators only; these events carry store_id = NULL) ────────
  {
    key: "platform.store_created",
    label: "Store created",
    description: "A merchant finished signup and created a store.",
    group: "Platform",
    section: "activity",
    severity: "success",
    audiences: { operators: IN_APP },
  },
  {
    key: "platform.store_suspended",
    label: "Store suspended",
    description: "A store was suspended or reinstated by an operator.",
    group: "Platform",
    section: "activity",
    severity: "warning",
    audiences: { operators: IN_APP },
  },
  {
    key: "platform.plan_changed",
    label: "Store plan changed",
    description: "An operator granted, upgraded, or downgraded a store's plan.",
    group: "Platform",
    section: "activity",
    severity: "info",
    audiences: { operators: IN_APP },
  },
  {
    key: "platform.domain_verified",
    label: "Custom domain verified",
    description: "A store's custom domain passed DNS verification.",
    group: "Platform",
    section: "activity",
    severity: "success",
    audiences: { operators: IN_APP },
  },
];

const EVENT_BY_KEY = new Map<string, EventDef>(EVENTS.map((e) => [e.key, e]));

// ── URL forms ──────────────────────────────────────────────────────────────
// Event keys contain dots (`order.placed`), which must NEVER appear in a
// dashboard URL: proxy.ts exempts asset-like paths from the session gate, and
// a dotted segment used to slip through it. So routes address a notification by
// its SLUG form, and the reverse lookup scans the registry rather than trying
// to invert the transformation — a lookup can't be tricked by a key that
// happens to contain the separator.

/** `order.placed` → `order-placed`, for use in a URL segment. */
export function eventKeySlug(key: string): string {
  return key.replace(/\./g, "-");
}

/** The event whose slug form matches, or undefined. */
export function eventFromSlug(slug: string): EventDef | undefined {
  if (!slug) return undefined;
  const wanted = slug.toLowerCase();
  return EVENTS.find((e) => eventKeySlug(e.key) === wanted);
}

export function getEventDef(key: string): EventDef | undefined {
  return EVENT_BY_KEY.get(key);
}

export function isEventKey(key: unknown): key is EventKey {
  return typeof key === "string" && EVENT_BY_KEY.has(key);
}

/** Events a store's admins can actually be notified about, grouped for the UI. */
export function storeAdminEvents(): EventDef[] {
  return EVENTS.filter(
    (e) => e.audiences["store-admins"] !== undefined && e.group !== "Platform",
  );
}

/**
 * Everything a MERCHANT can configure — anything reaching their team OR their
 * customers. This is what the console lists.
 *
 * Distinct from storeAdminEvents(): a shopper-facing notification like
 * "blog.approved" has no team audience at all, and leaving it out of the
 * console is precisely why merchants couldn't find where to edit the emails
 * their customers receive.
 */
export function merchantEvents(): EventDef[] {
  return EVENTS.filter(
    (e) =>
      e.group !== "Platform" &&
      (e.audiences["store-admins"] !== undefined ||
        e.audiences.customer !== undefined),
  );
}

/** Group → events, preserving EVENT_GROUPS order. Empty groups are dropped. */
export function groupEvents(defs: readonly EventDef[]): {
  group: EventGroup;
  events: EventDef[];
}[] {
  return EVENT_GROUPS.map((group) => ({
    group,
    events: defs.filter((d) => d.group === group),
  })).filter((g) => g.events.length > 0);
}

/** A stored preference row, flattened. NULL/undefined = "no opinion here". */
export interface PreferenceOverride {
  inApp?: boolean | null;
  email?: boolean | null;
  digest?: Digest | null;
}

export interface ResolvedChannels {
  inApp: boolean;
  email: boolean;
  digest: Digest;
}

/**
 * Resolve what actually gets delivered, in precedence order:
 *   registry default  ←  store default  ←  the recipient's own override
 *
 * A non-configurable event ignores both overrides — that is the whole point of
 * the flag. Unknown audiences resolve to "deliver nothing", so a routing bug
 * can never fan an event out to people it was never meant for.
 */
export function resolveChannels(
  def: EventDef,
  audience: Audience,
  storePref?: PreferenceOverride | null,
  userPref?: PreferenceOverride | null,
): ResolvedChannels {
  const base = def.audiences[audience];
  if (!base) return { inApp: false, email: false, digest: "instant" };
  if (def.configurable === false) {
    return { inApp: base.inApp, email: base.email, digest: "instant" };
  }

  const pick = (channel: Channel): boolean => {
    const user = userPref?.[channel];
    if (typeof user === "boolean") return user;
    const store = storePref?.[channel];
    if (typeof store === "boolean") return store;
    return base[channel];
  };

  const digest = userPref?.digest ?? storePref?.digest ?? "instant";
  return {
    inApp: pick("inApp"),
    email: pick("email"),
    digest: DIGESTS.includes(digest) ? digest : "instant",
  };
}
