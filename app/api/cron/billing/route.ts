import { NextResponse } from "next/server";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  getPlanPricingLive,
  getExtraLocationPricingLive,
} from "@/lib/plans/pricing";
import { PLAN_META, type Plan } from "@/lib/plans";
import {
  RENEWAL_BATCH,
  collectDueRenewals,
  downgradeExpired,
  evaluateCycleTurns,
} from "@/lib/billing/renewal-worker";
import {
  chargeUnavailableReason,
  getRecurringCharge,
} from "@/lib/billing/gateway";

// The billing heartbeat — the three renewal passes, in order.
//
//   COLLECT   at T−4d: issue the next cycle's invoice and charge it.
//   EVALUATE  at T0:   paid ⇒ advance the cycle; failed ⇒ grace starts.
//   DOWNGRADE at T0+48h: claim the downgrade and close the till.
//
// ★ THE ORDER WITHIN A RUN MATTERS. Evaluate must see the result of a
// collection that just landed, and downgrade must see a grace window that
// evaluate just opened — otherwise each pass is a full cron interval behind the
// one before it, and a merchant's 48-hour buffer silently becomes 48 hours plus
// two intervals. Running them together also means one late run cannot leave a
// subscription half-processed.
//
// ⚠ SCHEDULE THIS HOURLY. The cycle boundary and the grace deadline are both
// wall-clock instants, so the interval is the resolution of the whole system: a
// daily run would give some merchants nearly a day of unearned service and
// others nearly a day less notice than the 48 hours they are promised.
//
// ⚠ Deploying this route does NOT schedule it. Cloud Scheduler is a separate
// act — docs/cron-jobs.md records three jobs that were documented and never
// created, and the seo-refresh job that sat undeployed for months.
//
// Auth: `Authorization: Bearer <CRON_SECRET>`.

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // Fails CLOSED: an unset secret makes this endpoint unauthenticated, and it
  // can charge merchants and remove their plans.
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Plan and location prices, read LIVE.
 *
 * ★ Never the cached readers. This number decides a CHARGE, and quoting from a
 * cache an operator's reprice has not reached would debit the old amount — the
 * discipline `lib/plans/pricing.ts` already draws between
 * `getPlanPricing` and `getPlanPricingLive`.
 */
async function priceFor(plan: Plan, period: "monthly" | "yearly") {
  const [pricing, locationPrice] = await Promise.all([
    getPlanPricingLive(),
    getExtraLocationPricingLive(),
  ]);
  const row = pricing[plan];
  const inr = period === "yearly" ? row.yearlyInr : row.monthlyInr;
  const locInr =
    period === "yearly" ? locationPrice.yearlyInr : locationPrice.monthlyInr;
  return {
    planPaise: Math.round(inr * 100),
    locationPaise: Math.round(locInr * 100),
    planLabel: PLAN_META[plan].name,
  };
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const charge = getRecurringCharge();
  const chargeBlocked = chargeUnavailableReason();

  // ★★ PASS 1 ALWAYS RUNS. It ISSUES the invoice; whether it also CHARGES it
  // depends on the gateway. Skipping the whole pass when the charge is
  // unavailable — which is what this did — meant no invoice was ever written, so
  // pass 2 waited forever, nobody was downgraded, every subscriber got free
  // service past their cycle end, and the manual payment surface had nothing to
  // list. A null `charge` issues and finalizes the invoice, then stops: the
  // merchant pays it on /dashboard/plans. NOT a stub charge — an unreachable
  // provider is an UNKNOWN outcome, not a decline, so every attempt would sit in
  // reconciliation forever.
  const collect = await collectDueRenewals({
    now,
    limit: RENEWAL_BATCH,
    charge,
    priceFor,
  });

  const evaluate = await evaluateCycleTurns({
    now,
    limit: RENEWAL_BATCH,
    // Only affects the wording of the overdue email — see evaluateCycleTurns.
    autopayConfigured: !!charge,
  });
  const downgrade = await downgradeExpired({ now, limit: RENEWAL_BATCH });

  const errors = collect.errors + evaluate.errors + downgrade.errors;

  // More work than one batch could hold. Reported so a caller can run again
  // sooner, but NOT an error — a backlog draining is normal.
  const more =
    collect.considered >= RENEWAL_BATCH ||
    evaluate.advanced + evaluate.graced + evaluate.waiting + evaluate.ended >=
      RENEWAL_BATCH ||
    downgrade.downgraded >= RENEWAL_BATCH;

  const body = {
    ok: errors === 0,
    collectionSkipped: chargeBlocked,
    collect,
    evaluate,
    downgrade,
    more,
  };

  if (errors > 0) {
    logError("billing.cron", new Error("billing pass reported errors"), body);
    // ★ 503 so Cloud Scheduler's retries engage (the seo-refresh contract). A
    // failed pass here means money was not collected or a plan was not applied,
    // which is worth retrying — unlike a merchant who simply has not paid.
    return NextResponse.json(body, { status: 503 });
  }

  // ★ 200 while a backlog drains, and 200 when collection is unconfigured. A
  // permanently-red job is one nobody reads (the domain-reconcile lesson), and
  // neither of those is an outage.
  logInfo("billing.cron", body);
  return NextResponse.json(body);
}

export const GET = handle;
export const POST = handle;
