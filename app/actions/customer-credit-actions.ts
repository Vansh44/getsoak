"use server";

// ---------------------------------------------------------------------------
// A shopper's OWN store-credit balance — the storefront counterpart to the
// merchant's view of the same ledger in refund-actions.ts.
//
// WHY THIS EXISTS: credit was invisible to the person who owns it. It applied
// itself at checkout (`creditSplit.applied > 0`) and appeared NOWHERE else —
// not in the profile, not on an order. A shopper refunded to store credit had
// no way to learn they had any short of filling a cart and noticing the total
// drop, which is how a merchant gets "you never refunded me".
//
// SCOPE IS SERVER-DERIVED ON BOTH AXES. The customer is the verified session
// uid and the store is the HOST store; neither is ever read from the caller.
// That is what makes the `withService` reads inside lib/credit safe from here:
// there is no argument anyone could supply to aim them at another person's
// balance. Same double lock as customer-order-actions.ts — a Firebase uid is
// global, so the store scope is not redundant.
//
// ★ THE LEDGER'S `ref` AND `note` ARE DELIBERATELY NOT EXPOSED. `note` is
// internal wording ("Refund on ORD100110097" today, but the unbuilt merchant
// grant UI takes a free-text note) and `ref` carries internal ids — the AI
// ledger's precedent (§16) is an operator's EMAIL as the ref. The customer's
// description is derived from `kind` alone, a closed vocabulary this file
// owns, so a merchant's private note can never leak onto a storefront page.
// Don't "complete" the mapping by passing `note` through.
// ---------------------------------------------------------------------------

import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getCreditBalance, getCreditLedger } from "@/lib/credit/store-credit";

/** One movement, in the shape the storefront may see. No ref, no note. */
export interface MyCreditEntry {
  id: string;
  /** Positive = added to the balance, negative = spent. */
  delta: number;
  kind: string;
  createdAt: string | null;
}

export interface MyCreditSummary {
  balance: number;
  entries: MyCreditEntry[];
}

const EMPTY: MyCreditSummary = { balance: 0, entries: [] };

/** How many movements the profile card shows. Enough to explain the balance,
 *  not so many that the card becomes a statement. */
const RECENT_LIMIT = 10;

/**
 * This shopper's balance at THIS store, plus the recent movements behind it.
 *
 * Never throws and never rejects: both readers already swallow their errors
 * and return 0/[] (a balance is an OFFER — a DB blip must not break the page
 * it renders on), and a signed-out caller gets the same empty summary rather
 * than an error the profile page would have to special-case.
 */
export async function getMyCredit(): Promise<MyCreditSummary> {
  const user = await getServerUser();
  if (!user?.id) return EMPTY;

  // Throws (notFound) on a host that maps to no store, rather than returning
  // falsy — so there is deliberately no null branch here.
  const storeId = await requireStorefrontStoreId();

  const [balance, ledger] = await Promise.all([
    getCreditBalance(storeId, user.id),
    getCreditLedger(storeId, user.id, RECENT_LIMIT),
  ]);

  return {
    balance,
    entries: ledger.map((row) => ({
      id: row.id,
      delta: row.delta,
      kind: row.kind,
      createdAt: row.createdAt,
    })),
  };
}
