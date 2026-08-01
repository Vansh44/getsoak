// ---------------------------------------------------------------------------
// Manager approval at the till — as a signed grant, not a client flag.
//
// `verifyManagerPin` used to return a bare boolean and `placePosSale` used to
// trust an `opts.managerApproved` that arrived from the browser. Both are
// server ACTIONS, so the register's own JavaScript is not the only thing that
// can call them: a cashier who opens devtools can invoke placePosSale directly
// with `managerApproved: true` and take the whole over-cap discount without a
// manager ever touching the keypad. The PIN check was a UI step, not a gate.
//
// So approval is now a short-lived HMAC token minted by the PIN check and
// verified by the sale. It is bound to FOUR things, and every one of them is a
// bypass the boolean allowed:
//
//   store + location  — an approval given at one shop can't ring a sale at
//                       another.
//   operator          — it authorises THIS cashier's sale, not any sale that
//                       happens to be in flight on the same till.
//   fingerprint       — the exact cart and discount that were shown to the
//                       manager. Approving "₹50 off" cannot be replayed as
//                       "₹5,000 off", or against a different basket.
//   expiry            — three minutes, because approval means "I am standing
//                       here looking at this sale", not "this cashier may
//                       discount for the rest of the shift".
//
// ⚠ Known residual: within those three minutes the token can be presented
// twice for the IDENTICAL cart, so one approval could ring the same discounted
// sale twice. Making it strictly single-use needs server state (a used-nonce
// table) for a case where the manager is standing at the counter; the short
// TTL is the deliberate trade. Revisit if approvals ever move off-counter.
// ---------------------------------------------------------------------------

import "server-only";

import { createHash } from "node:crypto";
import { type BaseClaims, signToken, verifyToken } from "@/lib/pos/session";

/** How long a manager's approval stays good for. */
export const POS_APPROVAL_MAX_AGE_S = 3 * 60;

export interface PosApprovalClaims extends BaseClaims {
  t: "approval";
  storeId: string;
  locationId: string;
  /** The operator whose sale this authorises. Null on the owner path. */
  operatorId: string | null;
  /** pos_staff id of the manager who approved — carried for the audit trail. */
  approverId: string;
  /** Hash of the exact sale that was approved (see saleFingerprint). */
  fp: string;
}

/** The client-supplied parts of a sale that a manager is approving. */
export interface ApprovableSale {
  lines: Array<{
    productId: string;
    variantId?: string | null;
    quantity: number;
    lineDiscount?: number | null;
    priceOverride?: number | null;
  }>;
  orderDiscount?: number | null;
}

function num(v: unknown): number {
  return Number.isFinite(v) ? Math.round(Number(v) * 100) / 100 : 0;
}

/**
 * A stable hash of what the manager agreed to.
 *
 * Deliberately over the CLIENT'S INPUTS rather than the priced total: those
 * inputs are what both calls carry, and the charge is derived from them plus
 * DB prices the client can't influence. Change an item, a quantity, a
 * markdown, an override or the order discount and the fingerprint moves, so
 * the approval no longer fits.
 *
 * Lines are sorted, so re-ordering the cart between the PIN and the sale
 * doesn't invalidate an approval the manager really did give.
 */
export function saleFingerprint(sale: ApprovableSale): string {
  const lines = (Array.isArray(sale.lines) ? sale.lines : [])
    .map((l) => ({
      p: String(l?.productId ?? ""),
      v: l?.variantId ?? null,
      q: Math.trunc(Number(l?.quantity) || 0),
      d: num(l?.lineDiscount),
      // null and "no override" are the same thing; -1 can never be a price.
      o:
        l?.priceOverride === undefined || l?.priceOverride === null
          ? -1
          : num(l.priceOverride),
    }))
    .sort(
      (a, b) =>
        a.p.localeCompare(b.p) || String(a.v).localeCompare(String(b.v)),
    );

  return createHash("sha256")
    .update(JSON.stringify({ lines, od: num(sale.orderDiscount) }))
    .digest("base64url");
}

/** Mint an approval. Throws if POS_SESSION_SECRET is unset — callers check
 *  `posSessionConfigured()` first and return a readable error. */
export function signApprovalToken(claims: {
  storeId: string;
  locationId: string;
  operatorId: string | null;
  approverId: string;
  fingerprint: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    t: "approval",
    storeId: claims.storeId,
    locationId: claims.locationId,
    operatorId: claims.operatorId,
    approverId: claims.approverId,
    fp: claims.fingerprint,
    iat: now,
    exp: now + POS_APPROVAL_MAX_AGE_S,
  });
}

/**
 * Is this a real approval for THIS sale, at this till, for this operator?
 * Returns the claims (so the approver can be recorded) or null. Null is the
 * only failure mode — an unapproved sale is refused by the caller exactly as
 * if no token had been sent.
 */
export function verifyApprovalToken(
  token: string | undefined | null,
  expect: {
    storeId: string;
    locationId: string;
    operatorId: string | null;
    fingerprint: string;
  },
): PosApprovalClaims | null {
  const claims = verifyToken<PosApprovalClaims>(token, "approval");
  if (!claims) return null;
  if (claims.storeId !== expect.storeId) return null;
  if (claims.locationId !== expect.locationId) return null;
  if ((claims.operatorId ?? null) !== (expect.operatorId ?? null)) return null;
  if (claims.fp !== expect.fingerprint) return null;
  return claims;
}
