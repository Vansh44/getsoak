import "server-only";

/**
 * Settling payments whose outcome we never learned (§34).
 *
 * ★★ WHY THIS IS NOT OPTIONAL. `collect.ts` is deliberate that an UNKNOWN outcome
 * — a 5xx, a timeout, a throw — is never treated as a failure and is never
 * retried, because a retry might charge twice. That is right, and it leaves the
 * attempt sitting in `unknown` forever with nothing to resolve it. The same is
 * true of `processing`: nothing tells us a merchant closed the payment window, so
 * a dismissed checkout is indistinguishable from one still open. Until now
 * `billing_reconciliation_items` existed and NOTHING wrote or read it.
 *
 * ★ IT ASKS THE GATEWAY, IT DOES NOT GUESS. The only evidence that settles an
 * attempt as paid is a CAPTURED payment on the order we created. This uses
 * `rzpFetchOrderPayments` + `capturedPayment` — the same verified pair the §18
 * merchant-order reconciliation has used in production, not the unverified
 * recurring endpoint.
 *
 * ── The two directions, and why they are not symmetric ──
 *
 * FINDING MONEY is urgent and safe: a captured payment means the merchant paid,
 * and marking it so can only help them. It runs as soon as an attempt is stale.
 *
 * DECLARING FAILURE is neither. It frees the invoice for a fresh attempt, so
 * doing it to a payment still in flight invites a second charge. It therefore
 * waits far longer, and only when the gateway shows no captured payment at all.
 */

import { and, count, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  billingPaymentAttempts,
  billingReconciliationItems,
  stores,
} from "@/drizzle/schema";
import { logError, logInfo } from "@/lib/observability/logger";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpFetchOrderPayments,
} from "@/lib/payments/razorpay";
import type { ReconciliationItem } from "./invoice-types";
import { settleAttempt } from "./collect";
import { advanceAfterPayment } from "./renewal-worker";

export type { ReconciliationItem };

/**
 * How long an attempt may sit before we ask the gateway about it.
 *
 * ★ Long enough that an ordinary checkout is never interrupted. A Razorpay modal
 * can legitimately stay open for several minutes — a merchant reads the amount,
 * switches to their banking app, comes back — and asking about a live payment is
 * harmless but pointless.
 */
export const STALE_AFTER_MINUTES = 15;

/**
 * How long before an attempt with NO captured payment is declared failed.
 *
 * ★★ MUCH LONGER, and deliberately so. Failing an attempt releases the
 * one-in-flight index, so the merchant can start a new payment — which is exactly
 * what must not happen while the first might still land. UPI collect requests can
 * sit unanswered for a long time, and Razorpay's own X+3 window means a payment
 * can confirm days after it was initiated. A stranded attempt costs the merchant
 * a wait; a premature failure can cost them a double charge.
 */
export const FAIL_AFTER_HOURS = 72;

/** States that are not over, and so can still be resolved. */
const IN_FLIGHT = ["created", "processing", "authorized", "unknown"];

export interface ReconcileSummary {
  considered: number;
  /** Found captured at the gateway — money we had not recorded. */
  recovered: number;
  /** Declared failed after the long window, freeing the invoice. */
  failed: number;
  /** Asked, still no answer. Left alone. */
  stillUnknown: number;
  /** Flagged for a human. */
  flagged: number;
  errors: number;
}

export interface ReconcileDeps {
  now?: Date;
  limit?: number;
  /**
   * Injected so tests need no gateway. Production passes the real reader; a
   * caller with no credentials passes null and the sweep does nothing rather
   * than guessing.
   */
  fetchOrderPayments?: typeof rzpFetchOrderPayments | null;
}

/**
 * Resolve stranded payment attempts.
 *
 * Safe to run repeatedly: every settle is a conditional claim, and every
 * reconciliation row is deduped by a partial unique index.
 */
export async function reconcileStrandedAttempts(
  deps: ReconcileDeps = {},
): Promise<ReconcileSummary> {
  const now = deps.now ?? new Date();
  const summary: ReconcileSummary = {
    considered: 0,
    recovered: 0,
    failed: 0,
    stillUnknown: 0,
    flagged: 0,
    errors: 0,
  };

  const creds = getPlatformRazorpayCreds();
  const fetchPayments =
    deps.fetchOrderPayments === undefined
      ? rzpFetchOrderPayments
      : deps.fetchOrderPayments;
  // ★ No gateway, no reconciliation. Guessing from timestamps alone is how an
  // unpaid invoice gets marked paid.
  if (!creds || !fetchPayments) return summary;

  const staleBefore = new Date(
    now.getTime() - STALE_AFTER_MINUTES * 60_000,
  ).toISOString();

  let rows: {
    id: string;
    storeId: string;
    invoiceId: string;
    providerOrderId: string | null;
    amountPaise: number;
    state: string;
    createdAt: string;
  }[];
  try {
    rows = await withService(async (db) =>
      db
        .select({
          id: billingPaymentAttempts.id,
          storeId: billingPaymentAttempts.storeId,
          invoiceId: billingPaymentAttempts.invoiceId,
          providerOrderId: billingPaymentAttempts.providerOrderId,
          amountPaise: billingPaymentAttempts.amountPaise,
          state: billingPaymentAttempts.state,
          createdAt: billingPaymentAttempts.createdAt,
        })
        .from(billingPaymentAttempts)
        .where(
          and(
            inArray(billingPaymentAttempts.state, IN_FLIGHT),
            lt(billingPaymentAttempts.createdAt, staleBefore),
            // ★ Without an order there is nothing to ask about. An attempt that
            // never reached the gateway is handled below, not here.
            isNotNull(billingPaymentAttempts.providerOrderId),
          ),
        )
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(deps.limit ?? 100),
    );
  } catch (err) {
    logError("billing.reconcile.scan", err);
    summary.errors += 1;
    return summary;
  }

  const failBefore = now.getTime() - FAIL_AFTER_HOURS * 3_600_000;

  for (const row of rows) {
    summary.considered += 1;
    try {
      const res = await fetchPayments(creds, row.providerOrderId!);
      if (!res.ok) {
        // The gateway is unreachable. Not a verdict — try again next sweep.
        summary.stillUnknown += 1;
        continue;
      }

      const paid = capturedPayment(res.data);
      if (paid) {
        // ── Money we had not recorded ────────────────────────────────────
        const settled = await settleAttempt(row.id, "captured", {
          providerPaymentId: paid.id,
          now,
        });
        // null means a concurrent settle won; either way it is now recorded.
        if (settled === null || settled === "captured") {
          summary.recovered += 1;
          logInfo("billing.reconcile.recovered", {
            attemptId: row.id,
            storeId: row.storeId,
            invoiceId: row.invoiceId,
          });
          // ★ The plan follows the money. Without this a merchant who really did
          // pay stays in grace — and is downgraded — because the only thing that
          // advances a cycle is a paid invoice being NOTICED.
          await advanceAfterPayment(row.storeId, now);

          // ★★ AMOUNT MISMATCH IS A HUMAN QUESTION, not something to auto-fix.
          // We recorded the payment either way — the merchant paid — but if the
          // captured amount differs from what we asked for, somebody has to
          // decide what happens to the difference.
          if (
            typeof paid.amount === "number" &&
            paid.amount !== row.amountPaise
          ) {
            await flag({
              storeId: row.storeId,
              kind: "amount_mismatch",
              invoiceId: row.invoiceId,
              attemptId: row.id,
              providerPaymentId: paid.id,
              providerOrderId: row.providerOrderId,
              expectedPaise: row.amountPaise,
              observedPaise: paid.amount,
              detail: { note: "captured amount differs from the attempt" },
              now,
            });
            summary.flagged += 1;
          }
        }
        continue;
      }

      // ── No captured payment at the gateway ──────────────────────────────
      if (new Date(row.createdAt).getTime() < failBefore) {
        // Old enough that a payment landing now would be extraordinary, and the
        // gateway has told us there is none. Free the invoice.
        const settled = await settleAttempt(row.id, "failed", {
          failureCode: "reconciled_no_payment",
          failureReason: `no captured payment after ${FAIL_AFTER_HOURS}h`,
          now,
        });
        if (settled === null || settled === "failed") summary.failed += 1;
        continue;
      }

      // Still inside the window: it may yet land. Say nothing, change nothing.
      summary.stillUnknown += 1;
    } catch (err) {
      logError("billing.reconcile.one", err, { attemptId: row.id });
      summary.errors += 1;
    }
  }

  return summary;
}

/**
 * Record something a human has to look at.
 *
 * ★ Deduped by `billing_reconciliation_one_open_per_payment` (partial unique on
 * kind + provider payment, where status = 'open'), so a sweep that re-runs every
 * hour cannot bury the queue it exists to surface. A conflict is the NORMAL case
 * on the second pass, not an error.
 */
async function flag(input: {
  storeId: string | null;
  kind:
    | "unknown_payment"
    | "orphan_payment"
    | "amount_mismatch"
    | "missing_webhook"
    | "state_conflict"
    | "wrong_association"
    | "credit_grant_failed";
  invoiceId?: string | null;
  attemptId?: string | null;
  providerPaymentId?: string | null;
  providerOrderId?: string | null;
  expectedPaise?: number | null;
  observedPaise?: number | null;
  detail?: Record<string, unknown>;
  now: Date;
}): Promise<void> {
  try {
    await withService(async (db) => {
      await db
        .insert(billingReconciliationItems)
        .values({
          storeId: input.storeId,
          kind: input.kind,
          status: "open",
          invoiceId: input.invoiceId ?? null,
          attemptId: input.attemptId ?? null,
          providerPaymentId: input.providerPaymentId ?? null,
          providerOrderId: input.providerOrderId ?? null,
          expectedPaise: input.expectedPaise ?? null,
          observedPaise: input.observedPaise ?? null,
          detail: input.detail ?? {},
          createdAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        })
        .onConflictDoNothing();
    });
  } catch (err) {
    // Best-effort: failing to FLAG something must never undo the settlement that
    // prompted it. The money is already recorded correctly.
    logError("billing.reconcile.flag", err, { kind: input.kind });
  }
}

/**
 * The operator queue.
 *
 * ★ Joins the store's name, because an item is useless without knowing WHOSE
 * money it is and a uuid is not that. A null `store_id` is legitimate — an
 * orphan gateway payment that maps to no store yet is exactly the kind of thing
 * that needs a human.
 */
export async function listReconciliationItems(
  input: {
    status?: "open" | "resolved" | "manual_review" | "ignored";
    limit?: number;
  } = {},
): Promise<ReconciliationItem[]> {
  const status = input.status ?? "open";
  try {
    return await withService(async (db) =>
      db
        .select({
          id: billingReconciliationItems.id,
          storeId: billingReconciliationItems.storeId,
          storeName: stores.name,
          storeSlug: stores.slug,
          kind: billingReconciliationItems.kind,
          status: billingReconciliationItems.status,
          invoiceId: billingReconciliationItems.invoiceId,
          attemptId: billingReconciliationItems.attemptId,
          providerPaymentId: billingReconciliationItems.providerPaymentId,
          providerOrderId: billingReconciliationItems.providerOrderId,
          expectedPaise: billingReconciliationItems.expectedPaise,
          observedPaise: billingReconciliationItems.observedPaise,
          detail: billingReconciliationItems.detail,
          resolvedBy: billingReconciliationItems.resolvedBy,
          resolvedAt: billingReconciliationItems.resolvedAt,
          resolutionNote: billingReconciliationItems.resolutionNote,
          createdAt: billingReconciliationItems.createdAt,
        })
        .from(billingReconciliationItems)
        .leftJoin(stores, eq(stores.id, billingReconciliationItems.storeId))
        .where(eq(billingReconciliationItems.status, status))
        .orderBy(desc(billingReconciliationItems.createdAt))
        .limit(input.limit ?? 100),
    );
  } catch (err) {
    logError("billing.reconcile.list", err);
    return [];
  }
}

/** How many need a human right now — for a nav badge. */
export async function countOpenReconciliationItems(): Promise<number> {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({ n: count() })
        .from(billingReconciliationItems)
        .where(eq(billingReconciliationItems.status, "open"));
      return row?.n ?? 0;
    });
  } catch (err) {
    // ★ Fails to ZERO. A badge is a courtesy; a blip must cost the number, not
    // the page it sits on (the §22 pickup-count rule).
    logError("billing.reconcile.count", err);
    return 0;
  }
}

/**
 * Close an item.
 *
 * ★★ THIS MOVES NO MONEY, AND THAT IS THE WHOLE POINT. It records that a human
 * looked and what they decided — nothing else. An amount mismatch is closed by
 * refunding the difference, or issuing a credit, or deciding it does not matter;
 * all of those happen elsewhere, deliberately, by someone who chose them. A
 * button here that "fixed" a discrepancy would be a money movement nobody
 * reviewed.
 *
 * ★ A CONDITIONAL CLAIM on `open`, so two operators working the queue cannot
 * both close the same item and overwrite each other's note.
 */
export async function resolveReconciliationItem(input: {
  id: string;
  status: "resolved" | "manual_review" | "ignored";
  note: string;
  actor: string | null;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = input.now ?? new Date();
  const note = input.note.trim().slice(0, 1000);
  // ★ A reason is REQUIRED. "Resolved" with no note is indistinguishable from
  // someone clearing a queue they did not read, and this is the audit trail for
  // a money discrepancy.
  if (!note) {
    return {
      ok: false,
      error: "Say what you found — this is the audit trail.",
    };
  }
  try {
    const claimed = await withService(async (db) =>
      db
        .update(billingReconciliationItems)
        .set({
          status: input.status,
          resolvedBy: input.actor,
          resolvedAt: now.toISOString(),
          resolutionNote: note,
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(billingReconciliationItems.id, input.id),
            // ⚠ TEST GAP: the db mock does not evaluate WHERE clauses, so
            // removing this predicate fails no test. What IS covered is the
            // behaviour that depends on it — a claim returning zero rows is
            // reported as "someone else already closed that one" rather than as
            // success.
            eq(billingReconciliationItems.status, "open"),
          ),
        )
        .returning({ id: billingReconciliationItems.id }),
    );
    if (claimed.length === 0) {
      return { ok: false, error: "Someone else already closed that one." };
    }
    logInfo("billing.reconcile.resolved", {
      id: input.id,
      status: input.status,
      by: input.actor,
    });
    return { ok: true };
  } catch (err) {
    logError("billing.reconcile.resolve", err, { id: input.id });
    return { ok: false, error: "Couldn't save that. Please try again." };
  }
}
