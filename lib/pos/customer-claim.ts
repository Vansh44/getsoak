// ---------------------------------------------------------------------------
// Till-created customers, and how a real signup adopts one (roadmap Step 4).
//
// PURE. Everything here is a rule or a string; the DB work lives in the actions
// that call it, so the decisions can be tested without a database.
//
// ── The shape ──────────────────────────────────────────────────────────────
// A walk-in the till records gets a `users` row with a synthetic id and
// `claimed_at IS NULL`. When that same person signs up online with the same
// phone, the row is ADOPTED: its id becomes their Firebase uid. Their in-store
// history is theirs from the moment they create an account — which is the point
// of the feature, not a side effect of it.
// ---------------------------------------------------------------------------

import { normalizeIndianMobile } from "@/lib/phone";

/** Prefix marking a row the till invented rather than a signup creating. */
export const POS_CUSTOMER_PREFIX = "pos_";

/**
 * ★ AN UNCLAIMED ROW CAN NEVER LOG IN, AND NOTHING HAD TO BE BUILT FOR THAT.
 * Customer RLS is `auth.uid() = users.id`; a `pos_…` id matches no Firebase uid,
 * so these rows are invisible to every session. Do NOT add a policy for them —
 * the id shape is the mechanism.
 */
export function isPosCustomerId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(POS_CUSTOMER_PREFIX);
}

/** A new id for a till-created row. `crypto.randomUUID` is injected so this
 *  stays pure and testable. */
export function newPosCustomerId(uuid: () => string): string {
  return `${POS_CUSTOMER_PREFIX}${uuid()}`;
}

export interface ClaimCandidate {
  id: string;
  claimedAt: string | null;
}

export type ClaimDecision =
  | { action: "adopt"; posId: string }
  | { action: "attach"; existingId: string }
  | { action: "create" };

/**
 * What should happen when someone signs up with a phone that may already be on
 * a row for this store?
 *
 * ★ A COLLISION WITH A *CLAIMED* ROW IS NOT A CLAIM. If the matching row already
 * has an account behind it, that phone belongs to a real person — the signup
 * ATTACHES to it rather than adopting it. Adopting would hand one customer's
 * entire order history to whoever typed their number, which is the worst thing
 * this feature could do and the reason `claimed_at` exists at all.
 *
 * ★ AND THE ID SHAPE IS CHECKED TOO, not just `claimed_at`. A real signup row
 * also has `claimed_at IS NULL` (nothing backfills it — see the migration), so
 * treating NULL alone as "adoptable" would let a signup take over another
 * signup's row. Both conditions, always.
 */
export function decideClaim(existing: ClaimCandidate | null): ClaimDecision {
  if (!existing) return { action: "create" };
  if (isPosCustomerId(existing.id) && existing.claimedAt === null) {
    return { action: "adopt", posId: existing.id };
  }
  return { action: "attach", existingId: existing.id };
}

export interface PosCustomerInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export type PosCustomerValidation =
  | { ok: true; name: string; phone: string; email: string | null }
  | { ok: false; error: string };

/**
 * What the till must have before it can invent a customer.
 *
 * ★ PHONE IS REQUIRED, EMAIL IS NOT — and that asymmetry is the whole claim
 * story. The phone is what a later signup matches on, so a row without one can
 * never be adopted and is just an orphan with a name on it. Email is a nicety
 * for a receipt.
 *
 * ★ A WALK-IN WITH NO DETAILS IS STILL A SALE. This validates a customer the
 * cashier chose to record; it must never become a precondition for ringing one
 * up (roadmap invariant 6).
 */
export function validatePosCustomer(
  input: PosCustomerInput,
): PosCustomerValidation {
  const name = (input.name ?? "").trim().slice(0, 80);
  const phone = normalizePhone(input.phone);
  const email = (input.email ?? "").trim().toLowerCase().slice(0, 160) || null;

  if (!name) return { ok: false, error: "Give the customer a name." };
  if (!phone) {
    return {
      ok: false,
      error: "A mobile number is needed so they can be found again later.",
    };
  }
  if (email && !email.includes("@")) {
    return { ok: false, error: "That email doesn't look right." };
  }
  return { ok: true, name, phone, email };
}

/**
 * Indian mobile numbers, reduced to the 10 digits the `users` table stores.
 *
 * ★ IT MUST MATCH WHAT SIGNUP STORES, or the claim never fires. Someone whose
 * number the till took as "+91 98765 43210" and who later signs up as
 * "9876543210" is the SAME person, and if the two strings differ they get two
 * rows and lose their history. Returns "" when it isn't a recognisable mobile,
 * rather than storing something that can never be matched.
 *
 * ★★ IT DELEGATES TO `normalizeIndianMobile` RATHER THAN REIMPLEMENTING IT.
 * A second copy would drift, and this one already had: it accepted repeated-digit
 * placeholders like 8888888888, which the shared one rejects. That is not
 * cosmetic — `(store_id, phone)` is UNIQUE, so the SECOND cashier who typed
 * 8888888888 to get past the field would have silently ATTACHED their walk-in to
 * the FIRST one's record, merging two unrelated customers' order history. The
 * shared helper exists because Shiprocket rejects those numbers; the reason to
 * reject them here is different and stronger.
 *
 * ⚠ The return type differs deliberately — "" rather than null — because every
 * caller here feeds a NOT NULL text column and a falsy check reads the same.
 */
export function normalizePhone(raw: unknown): string {
  return normalizeIndianMobile(raw) ?? "";
}

/** Split a single typed name into the two columns `users` actually has. */
export function splitName(full: string): {
  first: string;
  last: string | null;
} {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
