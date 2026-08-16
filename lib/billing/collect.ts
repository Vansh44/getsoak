import "server-only";

/**
 * Collection — the payment-attempt lifecycle around a gateway call.
 *
 * Design: docs/billing-architecture.md §5. This is
 * `lib/payments/issue-refund.ts` generalised: that module is the only path in
 * the codebase that already handles "we never learned the outcome" correctly,
 * and every element of it transfers.
 *
 * ★★ THE ORDER IS THE WHOLE DESIGN:
 *
 *   1. INSERT the attempt row FIRST, carrying an idempotency key WE generated.
 *   2. Call the gateway, passing that key.
 *   3. Claim the outcome onto the row.
 *
 * You cannot key on a provider id you do not have yet, and a timeout is
 * indistinguishable from a success you never read. If step 2 or 3 dies, the row
 * survives with the key planted at the gateway, so reconciliation can find the
 * payment and settle it. The reverse order — charge, then record — loses money
 * silently the first time a process is killed mid-flight.
 *
 * ⚠ THE GATEWAY CALL IS INJECTED, not imported. The exact Razorpay
 * subsequent-charge endpoint is still unverified (docs/billing-architecture.md
 * §10), so inventing a signature here would bake a guess into the money path.
 * The seam keeps this module fully testable and lets the real call slot in once
 * it has been confirmed against a test-mode account.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import { billingInvoices, billingPaymentAttempts } from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import { notifyInvoicePaid } from "./receipts";
import type { RzpResult } from "@/lib/payments/razorpay";
import { collectionRoute, type MandateStatus } from "./cycle";
import {
  invoiceStatusForAttempts,
  isTerminal,
  resolvePaymentState,
  type PaymentState,
} from "./payment-state";

/** What the gateway tells us about one charge. */
export interface ChargeResponse {
  providerPaymentId: string;
  /** The gateway's own status; mapped through `mapGatewayStatus`. */
  status: string;
}

/**
 * The seam. An implementation MUST put `idempotencyKey` in provider-visible
 * metadata and MUST persist the provider order through
 * `recordProviderOrderId` before it attempts the debit. Razorpay's published
 * recurring-payment reference does not promise an idempotency header, so the
 * durable attempt + provider order are the duplicate guard and reconciliation
 * handle here; do not copy the refund API's endpoint-specific header.
 */
export type ChargeFn = (input: {
  amountPaise: number;
  idempotencyKey: string;
  providerTokenId: string;
  /** Razorpay requires the customer the token belongs to. */
  providerCustomerId: string | null;
  /** Which store is being billed — the implementation resolves its contact. */
  storeId: string;
  description: string;
  /** Persist the gateway order before any debit is attempted. */
  recordProviderOrderId: (providerOrderId: string) => Promise<boolean>;
}) => Promise<RzpResult<ChargeResponse>>;

export type CollectResult =
  | { status: "paid"; attemptId: string }
  | { status: "failed"; attemptId: string; code?: string; reason?: string }
  /** Outcome unknown — money may have moved. NEVER retry (Rule 1). */
  | { status: "pending_reconcile"; attemptId: string }
  | { status: "not_collectable"; reason: string }
  | { status: "already_in_flight" }
  | { status: "error" };

/**
 * Map the gateway's vocabulary onto ours.
 *
 * ★ Anything unrecognised becomes `unknown`, never `failed`. A status we do not
 * understand is missing information, and treating it as a failure would start a
 * grace clock and could trigger a second charge (Rule 6).
 */
export function mapGatewayStatus(status: string): PaymentState {
  switch ((status || "").toLowerCase()) {
    case "captured":
      return "captured";
    case "authorized":
      return "authorized";
    case "created":
    case "pending":
      return "processing";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      return "unknown";
  }
}

/** Terminal states must carry `resolved_at`; in-flight ones must not
 *  (billing_payment_attempts_resolved_shape). */
function resolvedAtFor(state: PaymentState, now: Date): string | null {
  return isTerminal(state) ? now.toISOString() : null;
}

export interface BeginAttemptInput {
  invoiceId: string;
  storeId: string;
  amountPaise: number;
  mode: "automatic" | "manual";
  mandateId?: string | null;
  providerTokenId?: string | null;
  /** Exact ceiling offered during a mandate-authorisation checkout. */
  mandateMaxPaise?: number | null;
}

export interface BeganAttempt {
  attemptId: string;
  idempotencyKey: string;
}

/**
 * Open an attempt, before any money moves.
 *
 * ★ A UNIQUE VIOLATION HERE IS A CORRECT ANSWER, not an error to log and
 * retry: `billing_payment_attempts_one_in_flight` means something is already
 * being collected for this invoice. Three clicks on Pay, or an automatic retry
 * racing a manual payment, land here (spec §28, §36). Returning null tells the
 * caller to leave it alone rather than open a second charge.
 */
export async function beginAttempt(
  input: BeginAttemptInput,
): Promise<BeganAttempt | null> {
  const idempotencyKey = randomUUID();
  try {
    return await withService(async (db) => {
      const rows = await db
        .insert(billingPaymentAttempts)
        .values({
          invoiceId: input.invoiceId,
          storeId: input.storeId,
          idempotencyKey,
          mode: input.mode,
          state: "created",
          amountPaise: input.amountPaise,
          mandateId: input.mandateId ?? null,
          providerTokenId: input.providerTokenId ?? null,
          mandateMaxPaise: input.mandateMaxPaise ?? null,
        })
        // The partial unique index is on the IN-FLIGHT states, so a conflict
        // means "already collecting", not "duplicate row".
        .onConflictDoNothing()
        .returning({ id: billingPaymentAttempts.id });

      const id = rows[0]?.id;
      return id ? { attemptId: id, idempotencyKey } : null;
    });
  } catch (err) {
    logError("billing.begin_attempt", err, { invoiceId: input.invoiceId });
    return null;
  }
}

/**
 * Attach the gateway order before money is asked to move.
 *
 * Write-once: an accidentally repeated provider call must not replace the
 * first reconciliation handle with a second order id.
 */
async function recordAttemptProviderOrder(
  attemptId: string,
  providerOrderId: string,
): Promise<boolean> {
  try {
    return await withService(async (db) => {
      const rows = await db
        .update(billingPaymentAttempts)
        .set({
          providerOrderId,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(billingPaymentAttempts.id, attemptId),
            eq(billingPaymentAttempts.state, "created"),
            isNull(billingPaymentAttempts.providerOrderId),
          ),
        )
        .returning({ id: billingPaymentAttempts.id });
      return rows.length === 1;
    });
  } catch (err) {
    logError("billing.record_provider_order", err, {
      attemptId,
      providerOrderId,
    });
    return false;
  }
}

/**
 * Fold an observed outcome into an attempt.
 *
 * ★ MONOTONIC, and claimed against the state we read. `resolvePaymentState`
 * decides whether the move is legal — a late `failed` after a `captured` is
 * rejected by the machine, with no timestamps involved (spec §26) — and the
 * UPDATE then claims on that exact prior state, so a concurrent settle cannot
 * overwrite a newer one.
 *
 * Returns the state the attempt ended up in, which is NOT always `incoming`.
 */
export async function settleAttempt(
  attemptId: string,
  incoming: PaymentState,
  extra: {
    providerPaymentId?: string | null;
    providerOrderId?: string | null;
    failureCode?: string | null;
    failureReason?: string | null;
    now?: Date;
  } = {},
): Promise<PaymentState | null> {
  const now = extra.now ?? new Date();
  try {
    const settled = await withService(async (db) => {
      const [current] = await db
        .select({
          id: billingPaymentAttempts.id,
          state: billingPaymentAttempts.state,
          invoiceId: billingPaymentAttempts.invoiceId,
          storeId: billingPaymentAttempts.storeId,
        })
        .from(billingPaymentAttempts)
        .where(eq(billingPaymentAttempts.id, attemptId))
        .limit(1);
      if (!current) return null;

      const from = current.state as PaymentState;
      const decision = resolvePaymentState(from, incoming);

      if (!decision.changed) {
        if (decision.ignored) {
          // Normal — a duplicate or out-of-order webhook. Worth a line: a flood
          // of these means something upstream is replaying.
          logWarn("billing.attempt_state_ignored", {
            attemptId,
            from,
            incoming,
          });
        }
        return {
          state: decision.state,
          becamePaid: false,
          storeId: null,
          invoiceId: current.invoiceId,
        };
      }

      const claimed = await db
        .update(billingPaymentAttempts)
        .set({
          state: decision.state,
          resolvedAt: resolvedAtFor(decision.state, now),
          providerPaymentId: extra.providerPaymentId ?? undefined,
          providerOrderId: extra.providerOrderId ?? undefined,
          failureCode: extra.failureCode ?? undefined,
          failureReason: extra.failureReason ?? undefined,
          updatedAt: now.toISOString(),
        })
        // ★ Claim on the state we based the decision on. Zero rows means a
        // concurrent settle moved it first, and ITS decision stands.
        .where(
          and(
            eq(billingPaymentAttempts.id, attemptId),
            eq(billingPaymentAttempts.state, from),
          ),
        )
        .returning({ state: billingPaymentAttempts.state });

      if (claimed.length === 0) return null;

      const sync = await syncInvoiceStatus(db, current.invoiceId, now);
      return {
        state: decision.state,
        becamePaid: sync.becamePaid,
        storeId: sync.becamePaid ? current.storeId : null,
        invoiceId: current.invoiceId,
      };
    });

    if (!settled) return null;

    // ★★ THE RECEIPT, from the ONE place an invoice becomes paid — so enrolment,
    // manual payment, a plan change, a location purchase and reconciliation all
    // send exactly one, and none of them has to remember to.
    //
    // ⚠ AFTER the transaction, always: an email is a network call, and sending
    // it inside would hold a pooled connection open for an HTTP request and
    // announce a payment a rollback then undid. Best-effort — the money is
    // recorded either way.
    if (settled.becamePaid && settled.storeId) {
      await notifyInvoicePaid(settled.storeId, settled.invoiceId);
    }
    return settled.state;
  } catch (err) {
    logError("billing.settle_attempt", err, { attemptId, incoming });
    return null;
  }
}

/**
 * Derive the invoice's status from its attempts.
 *
 * ★ DERIVED, never a flag someone has to remember to clear — the same reasoning
 * §26 gives for `refundOwed`. Only ever applied to collectable invoices:
 * `void` and `uncollectible` are DECISIONS, so this leaves them alone rather
 * than reviving an invoice the downgrade path deliberately closed.
 */
/**
 * Bring the invoice's status in line with its attempts.
 *
 * ★★ RETURNS WHETHER THIS CALL MADE IT PAID, which is what lets a receipt be
 * sent exactly once from one place. The transition is CLAIMED — the WHERE
 * excludes `paid` when moving TO paid — so a second settle on an
 * already-paid invoice matches no row and reports false.
 *
 * ⚠ That claim also fixes a quieter bug: `paidAt` used to be rewritten on every
 * subsequent sync, so a second attempt settling later moved the timestamp on an
 * invoice that had been paid for days.
 */
async function syncInvoiceStatus(
  db: Db,
  invoiceId: string,
  now: Date,
): Promise<{ becamePaid: boolean }> {
  const attempts = await db
    .select({ state: billingPaymentAttempts.state })
    .from(billingPaymentAttempts)
    .where(eq(billingPaymentAttempts.invoiceId, invoiceId));

  const next = invoiceStatusForAttempts(
    attempts.map((a) => a.state as PaymentState),
  );

  const claimed = await db
    .update(billingInvoices)
    .set({
      status: next,
      paidAt: next === "paid" ? now.toISOString() : undefined,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(billingInvoices.id, invoiceId),
        // Never revive a closed invoice — and when moving TO paid, never
        // re-claim one that already is.
        inArray(
          billingInvoices.status,
          next === "paid"
            ? ["open", "processing"]
            : ["open", "processing", "paid"],
        ),
      ),
    )
    .returning({ id: billingInvoices.id });

  return { becamePaid: next === "paid" && claimed.length > 0 };
}

export interface CollectInput {
  invoiceId: string;
  storeId: string;
  amountDuePaise: number;
  description: string;
  mandate: {
    id: string;
    status: MandateStatus | null;
    maxAmountPaise: number | null;
    providerTokenId: string | null;
    /** Razorpay attaches a mandate to a CUSTOMER; the charge needs both. */
    providerCustomerId?: string | null;
  } | null;
  charge: ChargeFn;
  now?: Date;
}

/**
 * Attempt automatic collection of one invoice.
 *
 * ★ ELIGIBILITY IS CHECKED BEFORE ANYTHING IS WRITTEN. `collectionRoute` applies
 * BOTH ceilings — what the mandate authorised and the AFA-exempt limit — so an
 * amount that would need the merchant to authenticate is routed to the manual
 * path rather than attempted and failed. A failed attempt starts a grace clock;
 * "not collectable automatically" must not.
 *
 * ★ AN UNKNOWN OUTCOME IS NOT A FAILURE. On `outcome: "unknown"` the attempt is
 * left in `unknown` and the caller is told to reconcile — never to retry, and
 * never to treat it as a decline (Rule 1, Rule 6, spec §27, §44).
 */
export async function collectInvoice(
  input: CollectInput,
): Promise<CollectResult> {
  const now = input.now ?? new Date();

  const route = collectionRoute({
    mandateStatus: input.mandate?.status ?? null,
    mandateMaxPaise: input.mandate?.maxAmountPaise ?? null,
    totalPaise: input.amountDuePaise,
  });
  if (!route.auto) return { status: "not_collectable", reason: route.reason };

  const tokenId = input.mandate?.providerTokenId;
  if (!tokenId) return { status: "not_collectable", reason: "no_mandate" };

  // Nothing to collect — a fully credited invoice is settled without a charge.
  if (input.amountDuePaise <= 0) {
    return { status: "not_collectable", reason: "nothing_due" };
  }

  const begun = await beginAttempt({
    invoiceId: input.invoiceId,
    storeId: input.storeId,
    amountPaise: input.amountDuePaise,
    mode: "automatic",
    mandateId: input.mandate?.id ?? null,
    providerTokenId: tokenId,
  });
  if (!begun) return { status: "already_in_flight" };

  let res: RzpResult<ChargeResponse>;
  try {
    res = await input.charge({
      amountPaise: input.amountDuePaise,
      idempotencyKey: begun.idempotencyKey,
      providerTokenId: tokenId,
      providerCustomerId: input.mandate?.providerCustomerId ?? null,
      storeId: input.storeId,
      description: input.description,
      recordProviderOrderId: (providerOrderId) =>
        recordAttemptProviderOrder(begun.attemptId, providerOrderId),
    });
  } catch (err) {
    // ★ A THROW IS AN UNKNOWN, not a failure. The request may well have reached
    // the gateway. Leave the attempt in `unknown` for reconciliation.
    logError("billing.charge_threw", err, { invoiceId: input.invoiceId });
    await settleAttempt(begun.attemptId, "unknown", { now });
    return { status: "pending_reconcile", attemptId: begun.attemptId };
  }

  if (!res.ok) {
    if (res.outcome === "unknown") {
      await settleAttempt(begun.attemptId, "unknown", { now });
      return { status: "pending_reconcile", attemptId: begun.attemptId };
    }
    await settleAttempt(begun.attemptId, "failed", {
      failureCode: "gateway_rejected",
      failureReason: res.error,
      now,
    });
    return {
      status: "failed",
      attemptId: begun.attemptId,
      code: "gateway_rejected",
      reason: res.error,
    };
  }

  const state = mapGatewayStatus(res.data.status);
  const settled = await settleAttempt(begun.attemptId, state, {
    providerPaymentId: res.data.providerPaymentId,
    now,
  });

  if (settled === "captured")
    return { status: "paid", attemptId: begun.attemptId };
  if (settled === "failed") {
    return { status: "failed", attemptId: begun.attemptId, code: "declined" };
  }
  // authorized / processing / unknown — the answer has not arrived yet, and the
  // X+3 window means that is the ORDINARY case for a recurring debit.
  return { status: "pending_reconcile", attemptId: begun.attemptId };
}

/** The most recent attempt for an invoice, for reconciliation and display. */
export async function latestAttempt(invoiceId: string) {
  try {
    return await withService(async (db) => {
      const [row] = await db
        .select({
          id: billingPaymentAttempts.id,
          state: billingPaymentAttempts.state,
          amountPaise: billingPaymentAttempts.amountPaise,
          idempotencyKey: billingPaymentAttempts.idempotencyKey,
          providerPaymentId: billingPaymentAttempts.providerPaymentId,
          failureReason: billingPaymentAttempts.failureReason,
          createdAt: billingPaymentAttempts.createdAt,
        })
        .from(billingPaymentAttempts)
        .where(eq(billingPaymentAttempts.invoiceId, invoiceId))
        .orderBy(desc(billingPaymentAttempts.createdAt))
        .limit(1);
      return row ?? null;
    });
  } catch (err) {
    logError("billing.latest_attempt", err, { invoiceId });
    return null;
  }
}
