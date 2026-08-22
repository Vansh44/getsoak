// ---------------------------------------------------------------------------
// What a customer is told about WHERE their refund went.
//
// ★★ THE DEFAULT MUST NEVER CLAIM THE ORIGINAL PAYMENT METHOD. Both refund
// renderers used to say "sent back to your original payment method"
// unconditionally, for every method — so a shopper refunded to STORE CREDIT
// (where no money leaves at all) was told their card had been credited, and one
// paid by hand was promised a bank timeline nobody had started. The event
// carried `paymentMethod` the whole time; neither renderer read it.
//
// So an unknown or absent method falls back to a phrase that is true whatever
// happened, and only a method we actually recognise earns a specific promise.
//
// Shared by lib/notifications/render.ts (the in-app line) and the email
// blueprint in default-templates.ts, so the two cannot drift.
// ---------------------------------------------------------------------------

export interface RefundCopy {
  /** Sentence fragment completing "Your refund has been …". */
  destination: string;
  /**
   * Whether the "banks take 5–7 working days" line is honest here. Only true
   * where a BANK is actually in the loop: cash over the counter clears
   * instantly and store credit never leaves.
   */
  bankDelay: boolean;
}

const GENERIC: RefundCopy = {
  // True of every method, which is exactly why it is the fallback.
  destination: "on its way back to you",
  bankDelay: false,
};

const BY_METHOD: Record<string, RefundCopy> = {
  // The gateway refund is the only one that provably returns to the instrument
  // the customer paid with — it is issued against that payment id.
  razorpay: {
    destination: "sent back to your original payment method",
    bankDelay: true,
  },
  card: { destination: "refunded to your card", bankDelay: true },
  upi: { destination: "sent back to your UPI account", bankDelay: true },
  cash: { destination: "refunded in cash at the counter", bankDelay: false },
  store_credit: {
    destination: "added to your store credit balance",
    bankDelay: false,
  },
  // The merchant moved the money themselves and we do not know by what route,
  // so we describe the fact and promise no timeline.
  manual: {
    destination: "sent to you by the store directly",
    bankDelay: false,
  },
};

/** How to describe a refund settled by `method`. Unknown → the safe generic. */
export function refundCopy(method: unknown): RefundCopy {
  if (typeof method !== "string") return GENERIC;
  return BY_METHOD[method.trim().toLowerCase()] ?? GENERIC;
}
