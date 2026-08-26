// ---------------------------------------------------------------------------
// Plan catalog — the single source of truth for StoreMink's subscription plans.
//
// Three plans, gated by business maturity:
//   free  → try it         (COD only, subdomain, small catalog)
//   basic → run a business (online payments, shipping, team tools)
//   pro   → scale it        (advanced analytics, POS, campaigns)
//
// `stores.plan` holds one of PLAN_IDS (DB CHECK constraint, plans_02_*.sql).
// Plans can be TIMED: `stores.plan_expires_at` (timestamptz, NULL = indefinite)
// bounds an operator-granted plan. Enforcement is two-layered — every read-site
// resolves the plan through effectivePlan() (expired ⇒ free, precise), and the
// daily /api/cron/plan-expiry job durably flips expired rows to free.
//
// Feature gating goes through planAllows()/limits here + the settings registry's
// per-setting `minPlan`. Pricing lives ONLY in this file so repricing is a
// one-line change; billing (Razorpay subscriptions) will consume these values.
//
// Pure module (no server/React imports) — shared by server actions, client
// components, and tests alike. Mirrors lib/settings/registry.ts.
// ---------------------------------------------------------------------------

export const PLAN_IDS = ["free", "basic", "pro"] as const;
export type Plan = (typeof PLAN_IDS)[number];

export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  basic: 1,
  pro: 2,
};

// Retired plan ids that may linger in un-migrated rows (or cached store
// objects) during a rollout — they degrade to their nearest live plan, never
// to a crash. "starter" was renamed to "basic" in plans_02_basic_and_expiry.sql.
const LEGACY_PLAN_ALIASES: Record<string, Plan> = {
  starter: "basic",
};

/** Coerce an arbitrary stores.plan value to a known plan (unknown → free). */
export function normalizePlan(plan: unknown): Plan {
  if (typeof plan !== "string") return "free";
  if (plan in PLAN_RANK) return plan as Plan;
  return LEGACY_PLAN_ALIASES[plan] ?? "free";
}

/**
 * The plan a store is ACTUALLY entitled to right now: its stored plan unless
 * that plan has expired (plan_expires_at in the past ⇒ free). Every gate that
 * reads stores.plan must resolve through this — the expiry cron flips rows
 * durably, but only once a day. An unparseable expiry is treated as
 * indefinite (fail open — junk data must never strip a paying merchant).
 */
export function effectivePlan(
  store: {
    plan?: unknown;
    plan_expires_at?: string | Date | null;
  },
  now: Date = new Date(),
): Plan {
  const plan = normalizePlan(store.plan);
  const raw = store.plan_expires_at;
  if (plan === "free" || raw == null) return plan;
  const expiresAt = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(expiresAt.getTime())) return plan;
  return expiresAt.getTime() <= now.getTime() ? "free" : plan;
}

/** Is `plan` at or above `minPlan`? (No minPlan = available on every plan.) */
export function planAllows(plan: Plan, minPlan?: Plan): boolean {
  if (!minPlan) return true;
  return PLAN_RANK[plan] >= PLAN_RANK[minPlan];
}

/** How a store came to be on its plan — a comp (operator-granted) plan must
 *  never be overwritten by billing webhooks, and vice versa. */
export const PLAN_SOURCES = ["comp", "paid", "trial"] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

// ── Display metadata (pricing page, upgrade dialogs, billing) ──────────────

export interface PlanMeta {
  id: Plan;
  name: string;
  tagline: string;
  /** INR per month, billed monthly. 0 = free. */
  monthlyInr: number;
  /** INR per year, billed yearly (≈2 months free). 0 = free. */
  yearlyInr: number;
}

export const PLAN_META: Record<Plan, PlanMeta> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Try StoreMink and set up your store",
    monthlyInr: 0,
    yearlyInr: 0,
  },
  basic: {
    id: "basic",
    name: "Basic",
    tagline: "Run a real business — payments, shipping, team tools",
    monthlyInr: 1500,
    // Ten months for twelve — the "two months free" the pricing page and the
    // FAQ both promise. Keep the 10× relationship if these ever move, or that
    // promise quietly stops being true.
    yearlyInr: 15000,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Scale with your team — advanced analytics, POS, campaigns",
    monthlyInr: 5000,
    yearlyInr: 50000,
  },
};

/**
 * An extra POS location, beyond what the plan includes (roadmap Step 5).
 *
 * THE DEFAULT ONLY — a platform operator sets the live price from the console
 * (`plan_prices`, key `extra_location`, see plans_05). This is what applies
 * until one ever has, exactly as `PLAN_META`'s prices are the fallback for the
 * tiers. Read it through `getExtraLocationPricingLive()` anywhere the number
 * decides what someone is CHARGED; never import this constant for that.
 *
 * Because `razorpay_plans` is keyed on the AMOUNT, a reprice mints a new
 * Razorpay plan and existing subscribers keep what they authorised until they
 * change something (§15b's grandfathering rule, inherited for free).
 *
 * Yearly is 10× monthly, the same "two months free" relationship `PLAN_META`
 * promises. Keep that ratio if these move, or the promise quietly stops being
 * true for the add-on while staying true for the plan.
 */
export const EXTRA_LOCATION_PRICE = {
  monthlyInr: 1000,
  yearlyInr: 10000,
} as const;

/**
 * The key the add-on is stored under in `plan_prices` (plans_05).
 *
 * ★ IT LIVES HERE, NOT IN lib/plans/pricing.ts, AND THAT IS LOAD-BEARING.
 * That module is `import "server-only"` — it pulls in the db client, and
 * therefore `pg` and `fs`. The operator's Pricing panel is a CLIENT component
 * and needs this key at runtime to tell the add-on row from a tier, so importing
 * it from there fails the BUILD (typecheck passes happily, which is what makes
 * it worth a comment). The TYPES may still come from pricing.ts — those are
 * erased. Same split as lib/logs/failure-types.ts and lib/themes/meta.ts.
 */
export const EXTRA_LOCATION_KEY = "extra_location";

// ── Limits & feature matrix ─────────────────────────────────────────────────
// `null` = unlimited. Enforced SERVER-SIDE in the owning action (a limit that
// only exists in the UI is a suggestion, not a limit). Enforcement is
// soft-on-downgrade: existing data is never deleted; creating NEW rows past the
// cap is blocked with an upgrade prompt.

export interface PlanLimits {
  /** Max products a store may have (null = unlimited). */
  maxProducts: number | null;
  /** Max staff accounts incl. the owner (null = unlimited). */
  maxStaff: number | null;
  /** AI generations per calendar month (null = unlimited). Purchased AI
   *  credits (lib/ai) top this up — the monthly allowance is consumed first. */
  aiGenerationsPerMonth: number | null;
  /** Max simultaneously-active coupons (null = unlimited). */
  maxActiveCoupons: number | null;
  /** May connect a custom domain. */
  customDomain: boolean;
  /** May connect a payment gateway (Razorpay) for online payments. */
  onlinePayments: boolean;
  /** May accept customer-authored blog drafts/submissions. Stored drafts are
   *  retained below this plan and become available again after an upgrade. */
  customerBlogSubmissions: boolean;
  /** May add and run sandboxed custom-code page sections. */
  customCode: boolean;
  /** May create and assign customer groups. */
  customerGroups: boolean;
  /** May create and edit custom dashboard roles. */
  customRoles: boolean;
  /** May connect Shiprocket for rates, fulfilment and tracking. */
  shippingIntegration: boolean;
  /** May customise the analytics dashboard and save layouts. */
  analyticsCustomization: boolean;
  /** May open drill-down analytics reports, CSV and Search Console data. */
  detailedAnalytics: boolean;
  /** May buy additional AI credits after the included allowance is used. */
  aiCreditTopUps: boolean;
  /** May send coupon email campaigns. */
  emailCampaigns: boolean;
  /** May connect merchant analytics pixels and use advanced conversion/margin
   *  reporting. Platform availability is a separate operator-controlled gate. */
  advancedAnalytics: boolean;
  /** "Powered by StoreMink" badge is removed from the storefront footer. */
  removeBadge: boolean;
  /** May use the Point of Sale (in-store register at /pos). Pro only. */
  posEnabled: boolean;
  /** POS locations included at no extra cost. Additional locations are billed
   *  per month (see docs/pos-plan.md §9.2 / Phase 7). 0 = POS not available. */
  posLocationsIncluded: number;
  /** Max simultaneously-authorized POS devices per location. Bounds the blast
   *  radius of a leaked pairing code and keeps the device list reviewable —
   *  a real shop runs a handful of registers, not dozens. */
  posDevicesPerLocation: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    maxProducts: 5,
    maxStaff: 1,
    aiGenerationsPerMonth: 3,
    maxActiveCoupons: 3,
    customDomain: false,
    onlinePayments: false,
    customerBlogSubmissions: false,
    customCode: false,
    customerGroups: false,
    customRoles: false,
    shippingIntegration: false,
    analyticsCustomization: false,
    detailedAnalytics: false,
    aiCreditTopUps: true,
    emailCampaigns: false,
    advancedAnalytics: false,
    removeBadge: false,
    posEnabled: false,
    posLocationsIncluded: 0,
    posDevicesPerLocation: 0,
  },
  basic: {
    maxProducts: 50,
    maxStaff: 3,
    aiGenerationsPerMonth: 10,
    maxActiveCoupons: null,
    // Pro only. Connecting a domain provisions a certificate per merchant on
    // the platform's load balancer — real infrastructure with a real ceiling,
    // unlike a row limit — so it sits on the top tier. The pricing page derives
    // its feature list from here, so this flag is also what it advertises.
    customDomain: false,
    onlinePayments: true,
    customerBlogSubmissions: true,
    customCode: true,
    customerGroups: true,
    customRoles: true,
    shippingIntegration: true,
    analyticsCustomization: true,
    detailedAnalytics: true,
    aiCreditTopUps: true,
    emailCampaigns: false,
    advancedAnalytics: false,
    removeBadge: true,
    posEnabled: false,
    posLocationsIncluded: 0,
    posDevicesPerLocation: 0,
  },
  pro: {
    maxProducts: null,
    maxStaff: null,
    aiGenerationsPerMonth: 50,
    maxActiveCoupons: null,
    customDomain: true,
    onlinePayments: true,
    customerBlogSubmissions: true,
    customCode: true,
    customerGroups: true,
    customRoles: true,
    shippingIntegration: true,
    analyticsCustomization: true,
    detailedAnalytics: true,
    aiCreditTopUps: true,
    emailCampaigns: true,
    advancedAnalytics: true,
    removeBadge: true,
    posEnabled: true,
    posLocationsIncluded: 2,
    posDevicesPerLocation: 5,
  },
};

/** The resolved limits for a raw stores.plan value (unknown plans → free). */
export function limitsFor(plan: unknown): PlanLimits {
  return PLAN_LIMITS[normalizePlan(plan)];
}

/** Boolean capabilities in PlanLimits. Used by the server entitlement helper
 * and the comparison UI so feature names cannot drift between layers. */
export type PlanFeature = {
  [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never;
}[keyof PlanLimits];

export type PlanMatrixValue = boolean | string;
export interface PlanMatrixRow {
  label: string;
  free: PlanMatrixValue;
  basic: PlanMatrixValue;
  pro: PlanMatrixValue;
}
export interface PlanMatrixSection {
  title: string;
  rows: readonly PlanMatrixRow[];
}

/** Complete customer-facing comparison. Values that are limits are derived
 * from PLAN_LIMITS; feature availability is enforced from the same object. */
export const PLAN_FEATURE_MATRIX: readonly PlanMatrixSection[] = [
  {
    title: "Storefront & catalogue",
    rows: [
      {
        label: "Hosted storefront and StoreMink subdomain",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Themes and visual page builder",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Products",
        free: String(PLAN_LIMITS.free.maxProducts),
        basic: String(PLAN_LIMITS.basic.maxProducts),
        pro: "Unlimited",
      },
      {
        label: "Custom HTML, CSS and JavaScript sections",
        free: false,
        basic: PLAN_LIMITS.basic.customCode,
        pro: PLAN_LIMITS.pro.customCode,
      },
      {
        label: "Custom domain",
        free: false,
        basic: false,
        pro: PLAN_LIMITS.pro.customDomain,
      },
      {
        label: "Remove Powered by StoreMink badge",
        free: PLAN_LIMITS.free.removeBadge,
        basic: PLAN_LIMITS.basic.removeBadge,
        pro: PLAN_LIMITS.pro.removeBadge,
      },
    ],
  },
  {
    title: "Selling & fulfilment",
    rows: [
      { label: "Cash on delivery", free: true, basic: true, pro: true },
      {
        label: "Online payments (your own gateway)",
        free: PLAN_LIMITS.free.onlinePayments,
        basic: PLAN_LIMITS.basic.onlinePayments,
        pro: PLAN_LIMITS.pro.onlinePayments,
      },
      {
        label: "GST invoices and tax classes",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Inventory, orders and returns",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Shiprocket integration",
        free: PLAN_LIMITS.free.shippingIntegration,
        basic: PLAN_LIMITS.basic.shippingIntegration,
        pro: PLAN_LIMITS.pro.shippingIntegration,
      },
      { label: "Point of Sale", free: false, basic: false, pro: true },
      {
        label: "Multi-location stock, transfers and store pickup",
        free: false,
        basic: false,
        pro: true,
      },
      {
        label: "Included POS locations",
        free: "—",
        basic: "—",
        pro: String(PLAN_LIMITS.pro.posLocationsIncluded),
      },
      {
        label: "Authorised tills per location",
        free: "—",
        basic: "—",
        pro: String(PLAN_LIMITS.pro.posDevicesPerLocation),
      },
    ],
  },
  {
    title: "Customers & marketing",
    rows: [
      {
        label: "Customer accounts, reviews and enquiries",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Customer blog submissions",
        free: PLAN_LIMITS.free.customerBlogSubmissions,
        basic: PLAN_LIMITS.basic.customerBlogSubmissions,
        pro: PLAN_LIMITS.pro.customerBlogSubmissions,
      },
      {
        label: "Customer groups",
        free: PLAN_LIMITS.free.customerGroups,
        basic: PLAN_LIMITS.basic.customerGroups,
        pro: PLAN_LIMITS.pro.customerGroups,
      },
      {
        label: "Active coupons",
        free: String(PLAN_LIMITS.free.maxActiveCoupons),
        basic: "Unlimited",
        pro: "Unlimited",
      },
      {
        label: "Coupon email campaigns",
        free: false,
        basic: false,
        pro: PLAN_LIMITS.pro.emailCampaigns,
      },
    ],
  },
  {
    title: "Team, analytics & AI",
    rows: [
      {
        label: "Staff accounts (including owner)",
        free: String(PLAN_LIMITS.free.maxStaff),
        basic: String(PLAN_LIMITS.basic.maxStaff),
        pro: "Unlimited",
      },
      {
        label: "Custom roles and permissions",
        free: PLAN_LIMITS.free.customRoles,
        basic: PLAN_LIMITS.basic.customRoles,
        pro: PLAN_LIMITS.pro.customRoles,
      },
      { label: "Core analytics dashboard", free: true, basic: true, pro: true },
      {
        label: "Custom dashboard, detailed reports and Search Console",
        free: false,
        basic: true,
        pro: true,
      },
      {
        label: "GA4, Meta Pixel, conversion and gross margin analytics",
        free: false,
        basic: false,
        pro: true,
      },
      {
        label: "Included AI generations each month",
        free: String(PLAN_LIMITS.free.aiGenerationsPerMonth),
        basic: String(PLAN_LIMITS.basic.aiGenerationsPerMonth),
        pro: String(PLAN_LIMITS.pro.aiGenerationsPerMonth),
      },
      {
        label: "Buy additional AI credits",
        free: true,
        basic: true,
        pro: true,
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Expiry warnings (notifications §22 — "fire on the crossing, not the state")
// ---------------------------------------------------------------------------

/** How many days ahead a merchant is told their timed plan is about to lapse. */
export const EXPIRY_WARN_DAYS = [7, 1] as const;

/**
 * The half-open window `(from, to]` of expiry timestamps that the `days`-ahead
 * warning covers on a run at `now`. PURE, so the once-only property is testable.
 *
 * Each horizon is a 24-HOUR BAND, not "≤ N days away". The cron runs daily, so
 * a band matches each store exactly once per horizon and needs no "already
 * warned" column to stay idempotent — whereas "≤ 7 days" would re-warn every
 * single day for a week, which is how a warning becomes noise.
 *
 * The trade-off is that a skipped cron day skips that horizon's warning. That's
 * acceptable: the backstop (the downgrade email when the plan actually lapses)
 * is unconditional, and the two horizons mean one missed run rarely silences
 * both.
 */
export function expiryWarnWindow(
  now: Date,
  days: number,
): { from: string; to: string } {
  const DAY_MS = 86_400_000;
  return {
    from: new Date(now.getTime() + (days - 1) * DAY_MS).toISOString(),
    to: new Date(now.getTime() + days * DAY_MS).toISOString(),
  };
}
