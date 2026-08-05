// What an exchange settles to (docs/returns-exchanges-plan.md §4).
//
// PURE. An exchange is a return plus a new order, and the only genuinely new
// arithmetic is "who owes whom, and how much" — which is worth having in one
// tested place, because getting it backwards means either billing a customer
// for a swap they were told was free or giving stock away.
//
// ── The v1 boundary, stated once ───────────────────────────────────────────
// ★ A REPLACEMENT MAY NOT COST MORE THAN WHAT IS COMING BACK.
//
// "Customer owes the difference" is a payment collection flow, and there isn't
// one outside checkout: it needs either a Razorpay payment link, or an order
// left unpaid that somebody has to chase. Half-building that produces
// replacement orders sitting in `pending` forever, which is worse than not
// offering it — so a dearer swap is REFUSED at request time with a sentence
// telling the shopper to place a new order instead.
//
// This is not a permanent limit, and it is deliberately the arithmetic that
// decides it rather than a flag: the day a payment-link flow exists,
// `customerOwes` already carries the number to charge.
//
// The 80% case is a same-price size or colour swap, which settles to zero and
// needs none of that.

const toPaise = (n: number) => Math.round((Number(n) || 0) * 100);
const toRupees = (p: number) => Math.round(p) / 100;

export interface ExchangeSettlement {
  /** Value of the goods coming back, excluding tax. */
  returnValue: number;
  /** Value of the replacements, excluding tax. */
  replacementValue: number;
  /** > 0 when the store must give money back on top of the swap. */
  storeOwes: number;
  /** > 0 when the replacement is dearer. Refused in v1 — see the header. */
  customerOwes: number;
  /** Nothing changes hands. The common case. */
  even: boolean;
  /** Whether this can be processed at all right now. */
  allowed: boolean;
  /** Why not, when it can't. Customer-facing. */
  blockedCopy: string | null;
}

/**
 * Settle a set of returned lines against their replacements.
 *
 * Both values EXCLUDE tax. Tax is recomputed on the replacement order at its
 * own class and today's rate, and refunded on the returned lines from their
 * stored snapshot — the two are not netted against each other, because they
 * are different transactions with the government (§4.2).
 */
export function exchangeSettlement(input: {
  returnValue: number;
  replacementValue: number;
}): ExchangeSettlement {
  const backP = Math.max(0, toPaise(input.returnValue));
  const outP = Math.max(0, toPaise(input.replacementValue));
  const diff = outP - backP;

  const customerOwes = diff > 0 ? toRupees(diff) : 0;
  const storeOwes = diff < 0 ? toRupees(-diff) : 0;

  return {
    returnValue: toRupees(backP),
    replacementValue: toRupees(outP),
    storeOwes,
    customerOwes,
    even: diff === 0,
    allowed: customerOwes === 0,
    blockedCopy:
      customerOwes > 0
        ? `That costs ₹${customerOwes.toFixed(2)} more than what you're sending back. Place a new order for it instead — we'll refund this one.`
        : null,
  };
}

export interface ExchangeLineRequest {
  orderItemId: string;
  quantity: number;
  /** Omitted = refund this line rather than swap it. */
  exchangeVariantId?: string | null;
  exchangeProductId?: string | null;
}

/** True when any line asks for a swap — the difference between a return and
 *  an exchange, which is otherwise the same object. */
export function isExchange(lines: ExchangeLineRequest[]): boolean {
  return lines.some((l) => Boolean(l.exchangeVariantId || l.exchangeProductId));
}
