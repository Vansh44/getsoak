/**
 * What a subscription looks like in its NEXT cycle — one pure answer (§34).
 *
 * ★★ WHY THIS IS ONE FUNCTION. Three places have to agree, and they run days
 * apart:
 *
 *   1. `collectOne`, at T−4d, PRICES the next cycle's invoice.
 *   2. `advanceCycle`, at T0, WRITES the new plan/period/count.
 *   3. The plans page, whenever, TELLS the merchant what is coming.
 *
 * If (1) and (2) disagree, the merchant is billed for something they did not get
 * or gets something they were not billed for — and the failure is silent, showing
 * up a month later as a number nobody can explain. So the scheduled fields are
 * resolved HERE and nowhere else.
 *
 * ★ A CANCELLATION IS NOT A CHANGE. `cancelAtPeriodEnd` means there IS no next
 * cycle, so it is reported separately rather than as "the same plan again" — pass
 * 1 must not invoice it and pass 2 must end the subscription instead of advancing
 * it. Collapsing the two is how a cancelled merchant gets one more bill.
 *
 * Pure, and imports only `lib/plans` (which is client-safe by design), so the
 * worker and a client component can both use it.
 */

import { limitsFor } from "@/lib/plans";

export type BillingPeriod = "monthly" | "yearly";

export interface ScheduledFields {
  plan: string;
  period: string;
  billedLocations: number;
  scheduledPlan: string | null;
  scheduledPeriod: string | null;
  scheduledLocations: number | null;
  cancelAtPeriodEnd: boolean;
}

export interface NextCycle {
  /** True when the subscription ENDS at the period end rather than renewing. */
  ending: boolean;
  plan: string;
  period: BillingPeriod;
  billedLocations: number;
  /** Did anything at all change from the current cycle? */
  changed: boolean;
}

function asPeriod(value: string | null | undefined): BillingPeriod {
  return value === "yearly" ? "yearly" : "monthly";
}

/**
 * Resolve the next cycle's shape from a subscription row.
 *
 * ★ `ending` wins over every scheduled change: a merchant who scheduled a
 * downgrade and then cancelled has cancelled, and applying the downgrade instead
 * would renew them onto a cheaper plan they explicitly stopped.
 */
export function resolveNextCycle(row: ScheduledFields): NextCycle {
  const currentPeriod = asPeriod(row.period);

  if (row.cancelAtPeriodEnd) {
    return {
      ending: true,
      plan: row.plan,
      period: currentPeriod,
      billedLocations: row.billedLocations,
      changed: true,
    };
  }

  const plan = row.scheduledPlan ?? row.plan;
  const period = row.scheduledPeriod
    ? asPeriod(row.scheduledPeriod)
    : currentPeriod;

  // ★★ A PLAN WITH NO POS CARRIES NO BILLABLE LOCATIONS. Renewing a merchant who
  // scheduled a downgrade off Pro while still charging for shops the new plan
  // cannot use is indefensible — and zeroing it HERE, rather than in the pricing,
  // is what stops the invoice and the write from disagreeing. The stored count is
  // deliberately NOT cleared by this: returning to Pro resumes billing for the
  // shops they still hold rather than handing them over free (the POS-7 rule).
  const wanted = row.scheduledLocations ?? row.billedLocations;
  const locations = limitsFor(plan).posLocationsIncluded > 0 ? wanted : 0;

  return {
    ending: false,
    plan,
    period,
    billedLocations: locations,
    changed:
      plan !== row.plan ||
      period !== currentPeriod ||
      locations !== row.billedLocations,
  };
}
