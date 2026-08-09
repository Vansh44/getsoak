import "server-only";

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { razorpayPlans } from "@/drizzle/schema";
import { getPlatformRazorpayCreds } from "./provider";
import { rzpCreatePlan, type RazorpayCreds } from "./razorpay";
import { PLAN_META, type Plan } from "@/lib/plans";
import {
  extraLocationPaise,
  subscriptionTotalPaise,
} from "@/lib/plans/location-billing";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
} from "@/lib/plans/pricing";
import { logError } from "@/lib/observability/logger";

// Recurring-billing helpers: resolve the Razorpay Plan id for a (tier, period)
// on the PLATFORM account, creating + caching it on first use so we never
// recreate a plan per checkout. The cache is keyed on the price (paise) too, so
// a reprice mints a NEW Razorpay plan rather than charging the stale amount.

export type BillingPeriod = "monthly" | "yearly";

/**
 * Server-computed price (paise) for a paid plan + period — the ONLY source of
 * the amount a merchant is charged (never trusted from the client).
 *
 * Reads the LIVE pricing, not the cached one: this number decides what someone
 * is billed, and quoting from a cache a reprice has not yet reached would
 * charge the old amount. It falls back to the lib/plans.ts constants when the
 * table is empty or unreadable (see lib/plans/pricing.ts).
 */
export async function planAmountPaise(
  plan: Plan,
  period: BillingPeriod,
): Promise<number> {
  const pricing = await getPlanPricingLive();
  const p = pricing[plan];
  const inr = period === "yearly" ? p.yearlyInr : p.monthlyInr;
  return inr * 100;
}

/** How much room to leave above the top plan when authorising a mandate. */
const MANDATE_HEADROOM = 2;

/** Extra locations a mandate is authorised to cover without re-authorising.
 *  See mandateMaxPaise for why this is well below MAX_EXTRA_LOCATIONS. */
export const MANDATE_LOCATION_ALLOWANCE = 10;

/** Total billing cycles Razorpay requires up front — set effectively "forever"
 *  (10 years) so the subscription renews until cancelled. */
export function totalCyclesFor(period: BillingPeriod): number {
  return period === "yearly" ? 10 : 120;
}

export interface ResolvedPlan {
  rzpPlanId: string;
  amountPaise: number;
}

/**
 * The Razorpay Plan id for (plan, period), from cache or freshly created.
 * Returns null only when the platform account isn't configured or the create
 * call fails.
 *
 * `extraLocations` folds metered POS locations into the AMOUNT rather than
 * billing them separately (roadmap Step 5). That works without a schema change
 * because the cache below is already keyed on the amount, so a different
 * location count resolves to a different cached plan id — and `planForRzpPlan`
 * still maps that id back to the right (tier, period) for the webhook, because
 * neither of those changed. See lib/plans/location-billing.ts for why this
 * beats a second mandate or per-cycle add-ons.
 */
export async function resolveRazorpayPlanId(
  plan: Plan,
  period: BillingPeriod,
  extraLocations = 0,
): Promise<ResolvedPlan | null> {
  if (plan === "free") return null;
  const creds = getPlatformRazorpayCreds();
  if (!creds) return null;

  // LIVE, like the plan price beside it: this decides what is debited, and a
  // cached add-on price a reprice has not reached would charge the old amount.
  const amountPaise = subscriptionTotalPaise(
    await planAmountPaise(plan, period),
    extraLocations,
    period,
    await getExtraLocationPricingLive(),
  );

  const cached = await withService((db) =>
    db
      .select({ rzp_plan_id: razorpayPlans.rzpPlanId })
      .from(razorpayPlans)
      .where(
        and(
          eq(razorpayPlans.plan, plan),
          eq(razorpayPlans.period, period),
          eq(razorpayPlans.amountPaise, amountPaise),
        ),
      )
      .limit(1),
  ).catch(() => []);
  if (cached[0]?.rzp_plan_id) {
    return { rzpPlanId: cached[0].rzp_plan_id, amountPaise };
  }

  const created = await createPlan(
    creds,
    plan,
    period,
    amountPaise,
    extraLocations,
  );
  if (!created) return null;

  // Cache best-effort; a lost race just recreates a (harmless) duplicate plan.
  await withService(
    (db) =>
      db
        .insert(razorpayPlans)
        .values({ plan, period, amountPaise, rzpPlanId: created })
        .onConflictDoUpdate({
          target: [
            razorpayPlans.plan,
            razorpayPlans.period,
            razorpayPlans.amountPaise,
          ],
          set: { rzpPlanId: created },
        }),
    // Best-effort: a lost cache write costs a duplicate Razorpay plan, not a
    // wrong charge — but it repeats on every checkout until someone sees it.
  ).catch((err) => logError("billing.plan_cache", err, { plan, period }));
  return { rzpPlanId: created, amountPaise };
}

async function createPlan(
  creds: RazorpayCreds,
  plan: Plan,
  period: BillingPeriod,
  amountPaise: number,
  extraLocations: number,
): Promise<string | null> {
  // The location count is in the NAME because it is not in any field Razorpay
  // stores — the amount is all it keeps. Without it, a merchant reading their
  // Razorpay invoice sees "StoreMink Pro (monthly)" charged at ₹7,000 with
  // nothing to explain the ₹2,000, and so does whoever answers that ticket.
  const suffix =
    extraLocations > 0
      ? ` + ${extraLocations} location${extraLocations === 1 ? "" : "s"}`
      : "";
  const res = await rzpCreatePlan(creds, {
    period,
    amountPaise,
    name: `StoreMink ${PLAN_META[plan].name} (${period})${suffix}`,
  });
  if (!res.ok) {
    // ★ This is the end of the road for an upgrade: the caller returns null
    // and the merchant is told the subscription couldn't start, with the
    // gateway's actual reason living only here.
    logError("billing.plan_create", res.error, {
      plan,
      period,
      amountPaise,
      extraLocations,
    });
    return null;
  }
  return res.data.id;
}

/**
 * The mandate's upper charge limit (paise). Set to the TOP plan's yearly price
 * so a later upgrade never exceeds the authorised mandate.
 *
 * ⚠ Now that an operator can reprice from the console, this is a moving
 * number — and a mandate already authorised at the OLD ceiling keeps that
 * ceiling. Raising Pro's yearly price above what an existing mandate
 * authorised means that merchant cannot upgrade into it without re-authorising.
 * That is the correct, safe failure (Razorpay refuses rather than over-charging
 * a mandate), but if repricing upward becomes routine this wants headroom —
 * a deliberate multiple of the top price rather than exactly it.
 */
export async function mandateMaxPaise(): Promise<number> {
  // HEADROOM, deliberately. The ceiling is fixed when the mandate is
  // authorised and can never be raised without the merchant re-authorising —
  // so pinning it to today's top price means any later price rise locks
  // existing subscribers out of upgrading, with "cancel and subscribe again"
  // as the only route. Doubling it costs nothing (a mandate is a ceiling, not
  // a charge; Razorpay only ever debits the plan amount) and absorbs a
  // reprice.
  const top = await planAmountPaise("pro", "yearly");
  // ★ Plus room for metered locations (roadmap Step 5), because their cost is
  // folded into the subscription AMOUNT — so a merchant who buys a shop two
  // years from now is charged against the ceiling authorised today.
  //
  // Not MAX_EXTRA_LOCATIONS (50): the mandate screen shows this number to the
  // merchant, and quoting a ₹6,00,000 ceiling to someone subscribing to a
  // ₹5,000/month plan is how you lose the signup. Ten covers every merchant
  // this product realistically serves; the eleventh gets a clear "re-authorise
  // to add more", which changeBilledLocations checks for explicitly rather than
  // letting Razorpay refuse the debit later.
  const locations =
    MANDATE_LOCATION_ALLOWANCE *
    extraLocationPaise("yearly", await getExtraLocationPricingLive());
  return top * MANDATE_HEADROOM + locations;
}

/**
 * What a Razorpay plan id actually costs, from our own cache of the plans we
 * created. Used to price a change against what the merchant pays TODAY rather
 * than against the catalog — an existing subscriber may be grandfathered on an
 * older, cheaper plan, and comparing to the catalog would misread a real
 * increase as a decrease and schedule it instead of charging it.
 *
 * Null when the id is unknown (a plan created before this cache, or by hand in
 * the dashboard); callers fall back to the catalog price.
 */
export async function amountForRzpPlan(
  rzpPlanId: string | null | undefined,
): Promise<number | null> {
  if (!rzpPlanId) return null;
  const rows = await withService((db) =>
    db
      .select({ amount_paise: razorpayPlans.amountPaise })
      .from(razorpayPlans)
      .where(eq(razorpayPlans.rzpPlanId, rzpPlanId))
      .limit(1),
  ).catch(() => [] as { amount_paise: number }[]);
  return rows[0]?.amount_paise ?? null;
}

/** The plan + period a Razorpay plan id maps to. The webhook needs both: after
 *  a period change the subscription's stored period is stale until we read it
 *  back from the plan Razorpay is actually billing. */
export async function planForRzpPlan(
  rzpPlanId: string | null | undefined,
): Promise<{ plan: string; period: BillingPeriod } | null> {
  if (!rzpPlanId) return null;
  const rows = await withService((db) =>
    db
      .select({ plan: razorpayPlans.plan, period: razorpayPlans.period })
      .from(razorpayPlans)
      .where(eq(razorpayPlans.rzpPlanId, rzpPlanId))
      .limit(1),
  ).catch(() => [] as { plan: string; period: string }[]);
  const r = rows[0];
  if (!r) return null;
  return {
    plan: r.plan,
    period: r.period === "yearly" ? "yearly" : "monthly",
  };
}
