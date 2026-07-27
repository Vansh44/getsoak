// ---------------------------------------------------------------------------
// Plan catalog — the single source of truth for StoreMink's subscription plans.
//
// Three plans, gated by business maturity:
//   free  → try it         (COD only, subdomain, small catalog)
//   basic → run a business (custom domain, online payments, AI copy)
//   pro   → scale it        (no product limits, staff roles, campaigns)
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
    tagline: "Run a real business — domain, payments, AI",
    monthlyInr: 500,
    yearlyInr: 5000,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Scale with your team — campaigns, no product limits",
    monthlyInr: 1500,
    yearlyInr: 15000,
  },
};

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
  /** May send coupon email campaigns. */
  emailCampaigns: boolean;
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
    maxProducts: 25,
    maxStaff: 1,
    aiGenerationsPerMonth: 3,
    maxActiveCoupons: 3,
    customDomain: false,
    onlinePayments: false,
    emailCampaigns: false,
    removeBadge: false,
    posEnabled: false,
    posLocationsIncluded: 0,
    posDevicesPerLocation: 0,
  },
  basic: {
    maxProducts: 500,
    maxStaff: 3,
    aiGenerationsPerMonth: 10,
    maxActiveCoupons: null,
    customDomain: true,
    onlinePayments: true,
    emailCampaigns: false,
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
    emailCampaigns: true,
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
