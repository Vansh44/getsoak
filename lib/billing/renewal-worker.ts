import "server-only";

/**
 * The renewal worker — three passes over the subscription fleet.
 *
 * Design: docs/billing-architecture.md §2c, §7.
 *
 *   COLLECT   at T−4d: build and issue the next cycle's invoice, then charge.
 *   EVALUATE  at T0:   paid ⇒ advance the cycle; failed ⇒ grace starts.
 *   DOWNGRADE at T0+48h: claim the downgrade and close the till.
 *
 * ★★ WHY COLLECTION HAPPENS FOUR DAYS EARLY. RBI requires a pre-debit
 * notification ≥24h ahead, and a recurring debit takes X+3 days to confirm. Bill
 * AT cycle start and the 2-day grace expires before the payment result is even
 * known — downgrading merchants whose money is still in flight, which is Rule 6
 * violated by a scheduling mistake. Collecting at T−4d means the answer is
 * already in hand when the cycle turns.
 *
 * ★ EACH PASS IS INDEPENDENTLY RE-RUNNABLE, and correctness never depends on a
 * lock. Two workers racing produce ONE invoice
 * (`billing_invoices_one_per_cycle`) and ONE charge
 * (`billing_payment_attempts_one_in_flight`), because those are database
 * constraints rather than application checks. Pass 2 does take
 * `FOR UPDATE SKIP LOCKED` — its work is entirely in-transaction, so the lock
 * actually spans it — while pass 1 deliberately does not, because its lock
 * would expire before the gateway call it was meant to protect. See `claimDue`.
 */

import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  billingInvoices,
  billingMandates,
  billingSubscriptions,
  posShifts,
} from "@/drizzle/schema";
import { logError, logInfo } from "@/lib/observability/logger";
import { limitsFor, type Plan } from "@/lib/plans";
import {
  collectionCutoff,
  cycleFrom,
  graceEndsAt,
  type MandateStatus,
} from "./cycle";
import { collectInvoice, type ChargeFn, type CollectResult } from "./collect";
import {
  amountDueForInvoice,
  ensureRenewalInvoice,
  finalizeInvoice,
  loadTaxContext,
} from "./invoice-store";
import { buildSubscriptionInvoice } from "./invoice";

/** How many subscriptions one pass will touch. Bounded so a Cloud Run request
 *  finishes; the cron self-chains while there is more. */
export const RENEWAL_BATCH = 50;

type BillingPeriod = "monthly" | "yearly";

export interface RenewalSummary {
  considered: number;
  collected: number;
  failed: number;
  pendingReconcile: number;
  manualRequired: number;
  errors: number;
}

interface DueRow {
  storeId: string;
  plan: string;
  period: string;
  currentCycleSeq: number;
  currentPeriodEnd: string | null;
  billedLocations: number;
  mandateId: string | null;
}

/**
 * PASS 1 — collect for every cycle starting within the lead window.
 *
 * The invoice covers the NEXT cycle: it begins where the current one ends.
 */
export async function collectDueRenewals(input: {
  now?: Date;
  limit?: number;
  /**
   * ★★ NULL = ISSUE THE INVOICE, DO NOT CHARGE. Issuing is not charging: it
   * writes a document saying what is owed, which the merchant settles by hand on
   * /dashboard/plans. Gating ISSUANCE behind the charge — which is what this
   * pass used to do, by being skipped wholesale — meant no invoice was ever
   * written, so pass 2 waited forever, grace never opened, nobody was ever
   * downgraded, and every subscriber silently received free service past their
   * cycle end. It also made the manual payment surface unreachable: it lists
   * open invoices, and there were none. The two must be separable, because
   * manual payment is a complete billing path on its own.
   */
  charge: ChargeFn | null;
  /** Injected so tests need no pricing table; production passes the LIVE
   *  reader, never a cached one — this number decides a charge. */
  priceFor: (
    plan: Plan,
    period: BillingPeriod,
  ) => Promise<{ planPaise: number; locationPaise: number; planLabel: string }>;
}): Promise<RenewalSummary> {
  const now = input.now ?? new Date();
  const summary: RenewalSummary = {
    considered: 0,
    collected: 0,
    failed: 0,
    pendingReconcile: 0,
    manualRequired: 0,
    errors: 0,
  };

  let due: DueRow[];
  try {
    due = await withService(async (db) =>
      claimDue(db, now, input.limit ?? RENEWAL_BATCH),
    );
  } catch (err) {
    logError("billing.renewal.claim", err);
    summary.errors += 1;
    return summary;
  }

  for (const row of due) {
    summary.considered += 1;
    try {
      const result = await collectOne(row, now, input);
      if (result === "paid") summary.collected += 1;
      else if (result === "failed") summary.failed += 1;
      else if (result === "manual") summary.manualRequired += 1;
      else summary.pendingReconcile += 1;
    } catch (err) {
      logError("billing.renewal.collect_one", err, { storeId: row.storeId });
      summary.errors += 1;
    }
  }
  return summary;
}

/**
 * Which subscriptions are due for collection?
 *
 * ★ COMPED STORES ARE EXCLUDED AT THE QUERY. They have no mandate and no
 * invoice, so billing them would invent an obligation an operator deliberately
 * waived — and `billingMayApplyPlan`'s comp-is-a-floor rule exists because that
 * mistake has been made here before.
 *
 * ⚠ DELIBERATELY NO `FOR UPDATE SKIP LOCKED` HERE, unlike pass 2. The row lock
 * would be released the instant this transaction commits, and the gateway call
 * happens well after that — a DB transaction and a Razorpay call are never one
 * atomic unit (spec §64). Holding it across the charge would mean keeping a
 * pooled connection open for the length of an external HTTP request, which is
 * how a fleet-wide renewal exhausts the pool.
 *
 * So two workers CAN select the same row, and it is still safe: one wins
 * `billing_invoices_one_per_cycle` and the other reads its invoice, then one
 * wins `billing_payment_attempts_one_in_flight` and the other is told
 * `already_in_flight` BEFORE it charges. The constraints are the guarantee; a
 * lock here would only have looked like one. If duplicated read work ever costs
 * enough to matter, the fix is a real lease column (the `data_jobs` pattern),
 * not a lock that expires before the work does.
 */
async function claimDue(db: Db, now: Date, limit: number): Promise<DueRow[]> {
  return db
    .select({
      storeId: billingSubscriptions.storeId,
      plan: billingSubscriptions.plan,
      period: billingSubscriptions.period,
      currentCycleSeq: billingSubscriptions.currentCycleSeq,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      billedLocations: billingSubscriptions.billedLocations,
      mandateId: billingSubscriptions.mandateId,
    })
    .from(billingSubscriptions)
    .where(
      and(
        inArray(billingSubscriptions.state, ["active", "past_due", "grace"]),
        sql`${billingSubscriptions.planSource} <> 'comp'`,
        isNotNull(billingSubscriptions.currentPeriodEnd),
        // A cycle beginning at or before the cutoff is inside the lead window.
        lte(
          billingSubscriptions.currentPeriodEnd,
          collectionCutoff(now).toISOString(),
        ),
      ),
    )
    .limit(limit);
}

async function collectOne(
  row: DueRow,
  now: Date,
  input: {
    charge: ChargeFn | null;
    priceFor: (
      plan: Plan,
      period: BillingPeriod,
    ) => Promise<{
      planPaise: number;
      locationPaise: number;
      planLabel: string;
    }>;
  },
): Promise<"paid" | "failed" | "manual" | "pending"> {
  const period: BillingPeriod = row.period === "yearly" ? "yearly" : "monthly";
  const plan = row.plan as Plan;
  const periodStart = new Date(row.currentPeriodEnd!);
  const next = cycleFrom(periodStart, period, row.currentCycleSeq + 1);

  const price = await input.priceFor(plan, period);
  const tax = await loadTaxContext(row.storeId);

  // ★ Locations are billed only if the TARGET plan can have them. Charging for
  // POS on a plan that cannot use it is indefensible (the §POS-7 rule).
  const locations =
    limitsFor(plan).posLocationsIncluded > 0
      ? { count: row.billedLocations, unitPaise: price.locationPaise }
      : undefined;

  const built = buildSubscriptionInvoice({
    planLabel: price.planLabel,
    period,
    planPaise: price.planPaise,
    locations,
    tax,
  });

  const invoice = await ensureRenewalInvoice({
    storeId: row.storeId,
    cycleSeq: next.seq,
    periodStart: next.start,
    periodEnd: next.end,
    dueAt: next.start,
    built,
  });
  if (!invoice) return "pending";

  // Already settled by an earlier run — nothing to do.
  if (invoice.status === "paid") return "paid";

  // ★ Finalize BEFORE charging. The document number is what the merchant is
  // being asked to pay against, and the pre-debit notification quotes it.
  if (!invoice.finalizedAt) {
    const issued = await finalizeInvoice(invoice.id, now);
    if (!issued) return "pending";
  }

  const amountDue = await amountDueForInvoice(invoice.id);
  if (amountDue === null) return "pending"; // Never guess an amount (Rule 10).

  // ★ No gateway: the invoice is issued and OPEN, and that is the whole job.
  // `manual` is the honest bucket — it already means "the merchant must pay this
  // themselves", which is exactly true here. Deliberately NOT a stub charge that
  // always fails: an unreachable provider is an UNKNOWN outcome, not a decline,
  // so every attempt would sit in reconciliation forever.
  if (!input.charge) return "manual";

  const mandate = await loadMandate(row.mandateId);
  const outcome = await collectInvoice({
    invoiceId: invoice.id,
    storeId: row.storeId,
    amountDuePaise: amountDue,
    description: `${price.planLabel} ${period} renewal`,
    mandate,
    charge: input.charge,
    now,
  });

  return classify(outcome);
}

/**
 * ★ `not_collectable` and `already_in_flight` are NOT failures. Neither may
 * start a grace clock: the first means the merchant must pay manually (an
 * amount over the AFA limit, a revoked mandate), and the second means a charge
 * is already running. Only a gateway REJECTION is a failure.
 */
export function classify(
  outcome: CollectResult,
): "paid" | "failed" | "manual" | "pending" {
  switch (outcome.status) {
    case "paid":
      return "paid";
    case "failed":
      return "failed";
    case "not_collectable":
      return "manual";
    case "already_in_flight":
    case "pending_reconcile":
      return "pending";
    default:
      return "pending";
  }
}

async function loadMandate(mandateId: string | null) {
  if (!mandateId) return null;
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingMandates.id,
          status: billingMandates.status,
          maxAmountPaise: billingMandates.maxAmountPaise,
          providerTokenId: billingMandates.providerTokenId,
        })
        .from(billingMandates)
        .where(eq(billingMandates.id, mandateId))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        status: row.status as MandateStatus,
        maxAmountPaise: row.maxAmountPaise,
        providerTokenId: row.providerTokenId,
      };
    });
  } catch (err) {
    logError("billing.renewal.load_mandate", err, { mandateId });
    return null;
  }
}

// ---------------------------------------------------------------------------
// PASS 2 — the cycle turns
// ---------------------------------------------------------------------------

export interface EvaluateSummary {
  advanced: number;
  graced: number;
  waiting: number;
  errors: number;
}

/**
 * At T0: advance a paid subscription into its new cycle, or start the grace
 * clock on one whose payment is known to have failed.
 *
 * ★★ AN UNRESOLVED PAYMENT IS LEFT ALONE. If the next cycle's invoice is
 * `processing` — which includes every `unknown` outcome — this does NOTHING: no
 * advance, no grace, no clock. Money may have moved and we do not yet know.
 * Starting a downgrade countdown on that is precisely what Rule 6 forbids, and
 * with the X+3 settlement window it is the ORDINARY state at the boundary, not
 * an edge case.
 */
export async function evaluateCycleTurns(
  input: {
    now?: Date;
    limit?: number;
  } = {},
): Promise<EvaluateSummary> {
  const now = input.now ?? new Date();
  const summary: EvaluateSummary = {
    advanced: 0,
    graced: 0,
    waiting: 0,
    errors: 0,
  };

  try {
    await withService(async (db) => {
      const rows = await db
        .select({
          storeId: billingSubscriptions.storeId,
          period: billingSubscriptions.period,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.state, "active"),
            sql`${billingSubscriptions.planSource} <> 'comp'`,
            isNotNull(billingSubscriptions.currentPeriodEnd),
            lte(billingSubscriptions.currentPeriodEnd, now.toISOString()),
          ),
        )
        .limit(input.limit ?? RENEWAL_BATCH)
        .for("update", { skipLocked: true });

      for (const row of rows) {
        const nextSeq = row.currentCycleSeq + 1;
        const [invoice] = await db
          .select({ status: billingInvoices.status })
          .from(billingInvoices)
          .where(
            and(
              eq(billingInvoices.storeId, row.storeId),
              eq(billingInvoices.kind, "subscription"),
              eq(billingInvoices.cycleSeq, nextSeq),
            ),
          )
          .limit(1);

        // No invoice at all yet, or one still in flight: wait. Pass 1 will make
        // it, and reconciliation will settle it.
        if (
          !invoice ||
          invoice.status === "processing" ||
          invoice.status === "draft"
        ) {
          summary.waiting += 1;
          continue;
        }

        if (invoice.status === "paid") {
          await advanceCycle(db, {
            storeId: row.storeId,
            period: row.period,
            fromCycleSeq: row.currentCycleSeq,
            fromPeriodEnd: row.currentPeriodEnd!,
            now,
          });
          summary.advanced += 1;
          continue;
        }

        // `open` — the invoice exists, was attempted, and is not paid.
        // ★ Grace is measured from NOW, the moment we observed and can notify —
        // deliberately not from the cycle boundary. If this worker was down for
        // a day, anchoring to the boundary would silently consume the merchant's
        // notice period for an outage that was ours (Rule 6's spirit).
        await db
          .update(billingSubscriptions)
          .set({
            state: "past_due",
            graceStartedAt: now.toISOString(),
            graceEndsAt: graceEndsAt(now).toISOString(),
            updatedAt: now.toISOString(),
          })
          .where(
            and(
              eq(billingSubscriptions.storeId, row.storeId),
              eq(billingSubscriptions.state, "active"),
            ),
          );
        summary.graced += 1;
      }
    });
  } catch (err) {
    logError("billing.renewal.evaluate", err);
    summary.errors += 1;
  }
  return summary;
}

/**
 * Move a subscription into its next cycle.
 *
 * ★ ONE implementation, shared by the worker's evaluate pass and by manual
 * payment. A second hand-written copy would drift, and the failure mode is
 * silent: a merchant's cycle dates would depend on which route settled their
 * invoice.
 *
 * ★ Claims on the cycle it was told about, so two concurrent advances cannot
 * double-advance a subscription. Returns whether it actually moved.
 */
async function advanceCycle(
  db: Db,
  input: {
    storeId: string;
    period: string;
    fromCycleSeq: number;
    fromPeriodEnd: string;
    now: Date;
  },
): Promise<boolean> {
  const period: BillingPeriod =
    input.period === "yearly" ? "yearly" : "monthly";
  const next = cycleFrom(
    new Date(input.fromPeriodEnd),
    period,
    input.fromCycleSeq + 1,
  );
  const claimed = await db
    .update(billingSubscriptions)
    .set({
      currentCycleSeq: next.seq,
      currentPeriodStart: next.start.toISOString(),
      currentPeriodEnd: next.end.toISOString(),
      state: "active",
      graceStartedAt: null,
      graceEndsAt: null,
      updatedAt: input.now.toISOString(),
    })
    .where(
      and(
        eq(billingSubscriptions.storeId, input.storeId),
        eq(billingSubscriptions.currentCycleSeq, input.fromCycleSeq),
      ),
    )
    .returning({ storeId: billingSubscriptions.storeId });
  return claimed.length > 0;
}

/**
 * Advance one store immediately, because its next-cycle invoice was just paid.
 *
 * ★★ CALLED BY MANUAL PAYMENT so a merchant who pays during grace gets their
 * plan back at once. Leaving it to the hourly worker would keep someone who has
 * just paid locked out of their own till for up to an hour, while they watch the
 * screen. It re-reads and re-checks everything rather than trusting the caller —
 * the invoice really is paid, the subscription really is theirs, and the cycle
 * really has turned.
 *
 * Returns true only when a cycle actually advanced, so the caller can tell the
 * merchant something true.
 */
export async function advanceAfterPayment(
  storeId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    return await withService(async (db) => {
      const [sub] = await db
        .select({
          storeId: billingSubscriptions.storeId,
          period: billingSubscriptions.period,
          currentCycleSeq: billingSubscriptions.currentCycleSeq,
          currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
          state: billingSubscriptions.state,
        })
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1);

      if (!sub?.currentPeriodEnd) return false;
      // Only a subscription whose cycle has ENDED can advance. Paying an invoice
      // early — the T−4d collection window — settles it without moving the
      // cycle; the boundary is what moves it, and the worker will.
      if (new Date(sub.currentPeriodEnd).getTime() > now.getTime())
        return false;
      if (!["active", "past_due", "grace"].includes(sub.state)) return false;

      const nextSeq = sub.currentCycleSeq + 1;
      const [invoice] = await db
        .select({ status: billingInvoices.status })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.storeId, storeId),
            eq(billingInvoices.kind, "subscription"),
            eq(billingInvoices.cycleSeq, nextSeq),
          ),
        )
        .limit(1);
      if (invoice?.status !== "paid") return false;

      return advanceCycle(db, {
        storeId,
        period: sub.period,
        fromCycleSeq: sub.currentCycleSeq,
        fromPeriodEnd: sub.currentPeriodEnd,
        now,
      });
    });
  } catch (err) {
    logError("billing.advance_after_payment", err, { storeId });
    return false;
  }
}

// ---------------------------------------------------------------------------
// PASS 3 — the downgrade
// ---------------------------------------------------------------------------

export interface DowngradeSummary {
  downgraded: number;
  shiftsClosed: number;
  errors: number;
}

/**
 * Downgrade every subscription whose grace has run out.
 *
 * ★ The decision is `billing_claim_downgrade()` — ONE statement that re-checks
 * state, deadline, comp exemption AND whether the invoice was paid, so a
 * payment racing the worker, a payment at the exact boundary, and the job
 * running twice all resolve with no lock and no read-then-write window.
 */
export async function downgradeExpired(
  input: {
    now?: Date;
    limit?: number;
  } = {},
): Promise<DowngradeSummary> {
  const now = input.now ?? new Date();
  const summary: DowngradeSummary = {
    downgraded: 0,
    shiftsClosed: 0,
    errors: 0,
  };

  let candidates: string[] = [];
  try {
    candidates = await withService(async (db) => {
      const rows = await db
        .select({ storeId: billingSubscriptions.storeId })
        .from(billingSubscriptions)
        .where(
          and(
            inArray(billingSubscriptions.state, ["past_due", "grace"]),
            sql`${billingSubscriptions.planSource} <> 'comp'`,
            isNotNull(billingSubscriptions.graceEndsAt),
            lte(billingSubscriptions.graceEndsAt, now.toISOString()),
          ),
        )
        .limit(input.limit ?? RENEWAL_BATCH);
      return rows.map((r) => r.storeId);
    });
  } catch (err) {
    logError("billing.renewal.downgrade_scan", err);
    summary.errors += 1;
    return summary;
  }

  for (const storeId of candidates) {
    try {
      const claimed = await withService(async (db) => {
        const res = await db.execute(
          sql`select billing_claim_downgrade(${storeId}::uuid, ${now.toISOString()}::timestamptz) as ok`,
        );
        const ok = (res.rows?.[0] as { ok?: boolean } | undefined)?.ok === true;
        if (!ok) return false;

        // ★ SAME TRANSACTION as the downgrade. posEnabled goes false, so the
        // till stops; an open shift holds uncounted cash and leaving it open
        // strands the drawer with no way to reconcile it (owner, 2026-08-11).
        await closeOpenShifts(db, storeId, now);
        return true;
      });

      if (claimed) {
        summary.downgraded += 1;
        summary.shiftsClosed += 1;
        logInfo("billing.downgraded", { storeId });
      }
    } catch (err) {
      logError("billing.renewal.downgrade", err, { storeId });
      summary.errors += 1;
    }
  }
  return summary;
}

/**
 * Force-close any open till for a store being downgraded.
 *
 * ★ `counted = expected`, so the variance is ZERO. A billing event must not
 * invent a discrepancy — a variance is read as a cashier being short, and
 * nobody counted this drawer. The note says who closed it and why, so the
 * Z-report explains itself.
 */
async function closeOpenShifts(db: Db, storeId: string, now: Date) {
  await db
    .update(posShifts)
    .set({
      status: "closed",
      closedAt: now.toISOString(),
      closedBy: null,
      closedByName: "System",
      countedCash: sql`coalesce(${posShifts.expectedCash}, 0)`,
      variance: 0,
      note: "Closed automatically: the store was downgraded to the Free plan for non-payment, which turns off Point of Sale. Cash was not counted, so this shift records no variance.",
    })
    .where(and(eq(posShifts.storeId, storeId), eq(posShifts.status, "open")));
}
