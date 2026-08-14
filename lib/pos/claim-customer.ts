import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { normalizePhone } from "./customer-claim";

// ---------------------------------------------------------------------------
// Adopting a till-created customer on signup (roadmap Step 4).
//
// ── ★★ ONE STATEMENT, AND EVERY GUARD INSIDE IT ────────────────────────────
// This rewrites a PRIMARY KEY that six other tables reference, so it is the
// single most dangerous write in the POS. It is therefore a conditional claim
// (roadmap invariant 3) with all four conditions in the WHERE — never
// check-then-act:
//
//   store_id = $store   the caller may not adopt another store's customer
//   phone    = $phone   from the VERIFIED auth identity, never from a form
//   id LIKE 'pos_%'     only a row the till invented
//   claimed_at IS NULL  and only one nobody has adopted already
//   NOT EXISTS (…$uid)  and only when this uid has no row of its own yet
//
// Two signups racing on one walk-in row: the loser matches zero rows and falls
// through to an ordinary insert. No lock, no window.
//
// ── Why the last condition is not optional ─────────────────────────────────
// `id` is the primary key. Someone who already has a `users` row — a returning
// shopper editing their profile — would hit a duplicate-key error instead of a
// clean no-op, and a raw PK violation surfacing on a profile save is both
// alarming and unactionable. Asking inside the statement keeps it a no-op.
//
// ── Why withService ────────────────────────────────────────────────────────
// Customer RLS is `auth.uid() = users.id`, and the row being adopted has a
// `pos_…` id by definition — so under the customer's own scope it is invisible
// and the UPDATE would match nothing. Service scope is what makes the write
// possible; the WHERE clause above is what makes it safe. Same trade placeOrder
// makes (convention #12): validate first, then write privileged.
// ---------------------------------------------------------------------------

export interface ClaimPosCustomerInput {
  /** The Firebase uid the row should become. */
  uid: string;
  /** The store whose customer this is — the HOST store, never caller input. */
  storeId: string;
  /**
   * The phone from the VERIFIED auth identity. A phone taken from a form would
   * let anyone type a stranger's number and inherit their order history — which
   * is the entire attack this feature has to not have.
   */
  verifiedPhone: string | null | undefined;
}

export interface ClaimResult {
  /** True when a till-created row was adopted. False means "nothing to adopt". */
  claimed: boolean;
  /** The id the adopted row used to have — for the audit line only. */
  previousId?: string;
}

/**
 * Adopt an unclaimed till-created customer for a freshly signed-up shopper.
 *
 * NEVER THROWS. A failure here means the shopper simply gets a new row and
 * loses the link to their in-store history — a disappointment, not an outage.
 * Failing their signup over it would be strictly worse.
 */
export async function claimPosCustomer(
  input: ClaimPosCustomerInput,
): Promise<ClaimResult> {
  const phone = normalizePhone(input.verifiedPhone);
  // No verified phone means nothing to match on. Not an error: most stores
  // never create a till customer, and most signups have nothing waiting.
  if (!phone || !input.uid || !input.storeId) return { claimed: false };

  try {
    const rows = await withService((db) =>
      db.execute(sql`
        update public.users
           set id = ${input.uid},
               claimed_at = now()
         where store_id = ${input.storeId}::uuid
           and phone = ${phone}
           and id like 'pos\\_%'
           and claimed_at is null
           and not exists (
             select 1 from public.users u2 where u2.id = ${input.uid}
           )
        returning id
      `),
    );

    const claimed = rowCount(rows) > 0;
    if (claimed) {
      // Worth a log line: it is a primary-key rewrite across six tables, and
      // "why does this account suddenly have in-store orders?" is a question
      // somebody will eventually ask.
      logInfo("pos customer claimed on signup", {
        storeId: input.storeId,
        uid: input.uid,
      });
    }
    return { claimed };
  } catch (err) {
    logError("pos customer claim failed", err, {
      storeId: input.storeId,
      uid: input.uid,
    });
    return { claimed: false };
  }
}

/**
 * `db.execute` returns a pg Result in this driver and a plain array in some
 * mocks; both shapes have to answer "did anything match?" the same way, because
 * the whole exactly-once guarantee is read from that number.
 */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const r = result as { rowCount?: number | null; rows?: unknown[] };
    if (typeof r.rowCount === "number") return r.rowCount;
    if (Array.isArray(r.rows)) return r.rows.length;
  }
  return 0;
}
