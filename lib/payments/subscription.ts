import "server-only";

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { razorpayPlans } from "@/drizzle/schema";
import { getPlatformRazorpayCreds } from "./provider";
import { rzpCreatePlan, type RazorpayCreds } from "./razorpay";
import { PLAN_META, type Plan } from "@/lib/plans";
import { getPlanPricingLive } from "@/lib/plans/pricing";

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
 */
export async function resolveRazorpayPlanId(
  plan: Plan,
  period: BillingPeriod,
): Promise<ResolvedPlan | null> {
  if (plan === "free") return null;
  const creds = getPlatformRazorpayCreds();
  if (!creds) return null;

  const amountPaise = await planAmountPaise(plan, period);

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

  const created = await createPlan(creds, plan, period, amountPaise);
  if (!created) return null;

  // Cache best-effort; a lost race just recreates a (harmless) duplicate plan.
  await withService((db) =>
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
  ).catch((err) => console.error("resolveRazorpayPlanId (cache):", err));
  return { rzpPlanId: created, amountPaise };
}

async function createPlan(
  creds: RazorpayCreds,
  plan: Plan,
  period: BillingPeriod,
  amountPaise: number,
): Promise<string | null> {
  const res = await rzpCreatePlan(creds, {
    period,
    amountPaise,
    name: `StoreMink ${PLAN_META[plan].name} (${period})`,
  });
  if (!res.ok) {
    console.error("resolveRazorpayPlanId (create):", res.error);
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
  return planAmountPaise("pro", "yearly");
}
