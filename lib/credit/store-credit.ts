import "server-only";

// Store credit — a balance a store owes a customer (roadmap Step 4 /
// returns-exchanges-plan Step 7).
//
// ── The ONE way credit moves ───────────────────────────────────────────────
// Every issue and every spend goes through the two RPCs, never through a hand
// written UPDATE. That is what makes the invariants hold: the balance can't go
// negative (a CHECK plus a conditional UPDATE), issuing is idempotent per ref,
// and the append-only ledger stays a complete explanation of the balance.
//
// ★ A balance is money. Treat a bug here the way you'd treat a bug in
// refunds — it is the same thing pointed the other way.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  customerCreditBalances,
  customerCreditLedger,
  orderRefunds,
} from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { toPaise, toRupees } from "@/lib/payments/refunds";

export type CreditKind = "refund" | "grant" | "spend" | "reinstate" | "expire";

export interface CreditLedgerRow {
  id: string;
  delta: number;
  kind: string;
  ref: string | null;
  note: string | null;
  createdAt: string | null;
}

/**
 * What this customer has at this store.
 *
 * Returns 0 on any error rather than throwing: a credit balance is an OFFER at
 * checkout, and a transient DB blip must never stop someone paying. The worst
 * case is they don't get to spend it this time.
 */
export async function getCreditBalance(
  storeId: string,
  customerId: string,
): Promise<number> {
  if (!storeId || !customerId) return 0;
  try {
    const rows = await withService((db) =>
      db
        .select({ balance: customerCreditBalances.balance })
        .from(customerCreditBalances)
        .where(
          and(
            eq(customerCreditBalances.storeId, storeId),
            eq(customerCreditBalances.customerId, customerId),
          ),
        )
        .limit(1),
    );
    return Math.max(0, Number(rows[0]?.balance ?? 0));
  } catch (err) {
    logError("credit.balance", err, { storeId, customerId });
    return 0;
  }
}

/**
 * Balances for several customers at once.
 *
 * ★ ONE query, not one per customer. The till's customer search returns up to
 * ten rows and runs on a keystroke burst at a counter; a per-row balance lookup
 * would turn one search into eleven round trips against a database ~46 ms away.
 *
 * Missing customers are simply absent from the map — the caller reads that as
 * zero, which is what no balance row means.
 */
export async function getCreditBalances(
  storeId: string,
  customerIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = customerIds.filter(Boolean);
  if (!storeId || ids.length === 0) return out;
  try {
    const rows = await withService((db) =>
      db
        .select({
          customerId: customerCreditBalances.customerId,
          balance: customerCreditBalances.balance,
        })
        .from(customerCreditBalances)
        .where(
          and(
            eq(customerCreditBalances.storeId, storeId),
            inArray(customerCreditBalances.customerId, ids),
          ),
        ),
    );
    for (const r of rows) {
      out.set(r.customerId, Math.max(0, Number(r.balance ?? 0)));
    }
  } catch (err) {
    // A failed read reports NO balances, which the till renders as "no credit
    // to spend" — the safe direction: it costs a customer the use of their
    // credit for a moment, where the opposite would offer money we could not
    // prove exists.
    logError("credit.balances", err, { storeId });
  }
  return out;
}

/**
 * Give a customer credit.
 *
 * `ref` makes it idempotent: crediting the same refund twice is a no-op that
 * returns false, so a retried confirmation can't double-issue. Pass one
 * whenever there is a thing being credited FOR — omit it only for a bare
 * goodwill grant, which by definition has nothing to deduplicate against.
 */
export async function issueCredit(input: {
  storeId: string;
  customerId: string;
  amount: number;
  kind: Exclude<CreditKind, "spend">;
  ref?: string | null;
  note?: string | null;
  actor?: string | null;
}): Promise<{ ok: boolean; alreadyIssued?: boolean; error?: string }> {
  const amount = toRupees(toPaise(input.amount));
  if (!(amount > 0))
    return { ok: false, error: "Amount must be more than zero." };
  if (!input.storeId || !input.customerId) {
    return { ok: false, error: "Missing store or customer." };
  }

  try {
    const res = await withService((db) =>
      db.execute(
        sql`select add_customer_credit(p_store => ${input.storeId}, p_customer => ${input.customerId}, p_amount => ${amount}, p_kind => ${input.kind}, p_ref => ${input.ref ?? null}, p_note => ${input.note ?? null}, p_actor => ${input.actor ?? null}) as ok`,
      ),
    );
    const ok = (res.rows[0] as { ok?: boolean } | undefined)?.ok === true;
    // false here means "this ref was already credited", which is success from
    // the caller's point of view — the customer has the money.
    return ok ? { ok: true } : { ok: true, alreadyIssued: true };
  } catch (err) {
    logError("credit.issue", err, {
      storeId: input.storeId,
      customerId: input.customerId,
    });
    return { ok: false, error: "Couldn't add store credit." };
  }
}

/**
 * Spend credit against an order.
 *
 * ★ ALL OR NOTHING for the amount asked. The caller works out how much to
 * apply (see `creditToApply`) and this either takes exactly that or takes
 * nothing — a partial deduction would leave the order charged for a different
 * total than the one the customer agreed to.
 *
 * Returns false when the balance moved underneath us, which is a normal race,
 * not an error: the caller charges the full amount instead.
 */
export async function spendCredit(input: {
  storeId: string;
  customerId: string;
  amount: number;
  orderId: string;
  note?: string | null;
}): Promise<boolean> {
  const amount = toRupees(toPaise(input.amount));
  if (!(amount > 0)) return false;
  try {
    const res = await withService((db) =>
      db.execute(
        sql`select try_spend_customer_credit(p_store => ${input.storeId}, p_customer => ${input.customerId}, p_amount => ${amount}, p_ref => ${input.orderId}, p_note => ${input.note ?? null}) as ok`,
      ),
    );
    return (res.rows[0] as { ok?: boolean } | undefined)?.ok === true;
  } catch (err) {
    logError("credit.spend", err, {
      storeId: input.storeId,
      orderId: input.orderId,
    });
    return false;
  }
}

/**
 * Give back credit an order spent, because the order is no longer happening.
 *
 * ★ Keyed on the ORDER, so it is exactly-once: a cancel that runs twice
 * reinstates once. Without that, cancelling an order twice would mint money.
 */
export async function reinstateCreditForOrder(
  storeId: string,
  orderId: string,
): Promise<number> {
  try {
    const spent = await withService((db) =>
      db
        .select({
          customer_id: customerCreditLedger.customerId,
          delta: customerCreditLedger.delta,
        })
        .from(customerCreditLedger)
        .where(
          and(
            eq(customerCreditLedger.storeId, storeId),
            eq(customerCreditLedger.kind, "spend"),
            eq(customerCreditLedger.ref, orderId),
          ),
        ),
    );
    if (!spent.length) return 0;

    // ★ A REFUND ALREADY PAID AS CREDIT HAS ALREADY GIVEN IT BACK.
    //
    // Refund-then-cancel is an ordinary sequence — you settle with the
    // customer, then mark the order dead — and the two halves knew nothing
    // about each other. On an order paid entirely with credit that meant the
    // refund credited the balance once and this credited it AGAIN, so a ₹500
    // order settled with ₹500 of credit left the customer holding ₹1,000. The
    // idempotency keys can't catch it: they are per (kind, ref), and these are
    // a `refund` keyed on the refund and a `reinstate` keyed on the order.
    //
    // Only CREDIT refunds offset this. A cash or gateway refund returned the
    // money half of the order and says nothing about the credit half — netting
    // those off would swallow a balance the customer is still owed.
    const creditedBack = await withService((db) =>
      db
        .select({
          total: sql<string>`coalesce(sum(${orderRefunds.amount}), 0)`,
        })
        .from(orderRefunds)
        .where(
          and(
            eq(orderRefunds.orderId, orderId),
            eq(orderRefunds.method, "store_credit"),
            eq(orderRefunds.status, "completed"),
          ),
        ),
    ).catch((err) => {
      // Fail toward reinstating: a customer silently losing a balance they
      // paid with is worse than a store occasionally over-crediting, and the
      // ledger makes the latter visible.
      logError("credit.reinstate_offset", err, { storeId, orderId });
      return [{ total: "0" }];
    });
    let offset = Math.max(0, Number(creditedBack[0]?.total ?? 0));

    let returned = 0;
    for (const row of spent) {
      let amount = Math.abs(Number(row.delta) || 0);
      if (offset > 0) {
        const used = Math.min(offset, amount);
        amount -= used;
        offset -= used;
      }
      if (amount <= 0) continue;
      const res = await issueCredit({
        storeId,
        customerId: row.customer_id,
        amount,
        kind: "reinstate",
        // The order id again — the UNIQUE index is per (kind, ref), so the
        // 'spend' row and this 'reinstate' row don't collide, but a SECOND
        // reinstate for the same order does.
        ref: orderId,
        note: "Order cancelled",
      });
      if (res.ok && !res.alreadyIssued) returned += amount;
    }
    return returned;
  } catch (err) {
    logError("credit.reinstate", err, { storeId, orderId });
    return 0;
  }
}

/** Recent movements, newest first — the customer's and the merchant's view. */
export async function getCreditLedger(
  storeId: string,
  customerId: string,
  limit = 50,
): Promise<CreditLedgerRow[]> {
  if (!storeId || !customerId) return [];
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: customerCreditLedger.id,
          delta: customerCreditLedger.delta,
          kind: customerCreditLedger.kind,
          ref: customerCreditLedger.ref,
          note: customerCreditLedger.note,
          createdAt: customerCreditLedger.createdAt,
        })
        .from(customerCreditLedger)
        .where(
          and(
            eq(customerCreditLedger.storeId, storeId),
            eq(customerCreditLedger.customerId, customerId),
          ),
        )
        .orderBy(desc(customerCreditLedger.createdAt))
        .limit(limit),
    );
    return rows.map((r) => ({ ...r, delta: Number(r.delta ?? 0) }));
  } catch (err) {
    logError("credit.ledger", err, { storeId, customerId });
    return [];
  }
}
