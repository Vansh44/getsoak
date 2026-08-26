// ---------------------------------------------------------------------------
// Who pays when, for a collection order — the rule, on its own so it can be
// tested without a gateway (roadmap Step 1.2).
//
// Three policies, set by the merchant (`fulfilment.pickupPayment`):
//
//   customer_choice  both offered — today's behaviour, and the default
//   prepaid          paid online when the order is placed
//   at_store         settled at the counter on collection
//
// ★ THE SAME FUNCTION ANSWERS FOR THE PICKER AND FOR `placeOrder`. The checkout
// screen asks it which controls to render; the server asks it whether the method
// that came back is allowed. One implementation means the UI can never offer
// something the server then refuses in front of a customer — the rule
// `RegisterConfig.canDiscount` follows at the till (CODEBASE §22), applied to
// the other counter.
// ---------------------------------------------------------------------------

/** What checkout can settle an order with. `pay_at_store` is a collection-only
 *  counterpart to COD — a promise to pay, not an instrument (CODEBASE §23). */
export type CheckoutPaymentMethod = "cod" | "razorpay" | "pay_at_store";

export type PickupPaymentPolicy = "customer_choice" | "prepaid" | "at_store";

export type Fulfilment = "delivery" | "pickup";

/** Unknown or missing values resolve to today's behaviour rather than to a
 *  stricter policy nobody chose — a setting that fails closed would stop a
 *  store selling on a typo. */
export function normalizePickupPayment(v: unknown): PickupPaymentPolicy {
  return v === "prepaid" || v === "at_store" ? v : "customer_choice";
}

export interface PaymentOptionsInput {
  fulfilment: Fulfilment;
  /** Is a payment gateway actually connected and entitled right now? */
  onlineAvailable: boolean;
  policy: PickupPaymentPolicy;
}

export interface PaymentOptions {
  /** Offer "Pay online". */
  online: boolean;
  /** Offer the pay-later option — COD on a delivery, pay-at-store on a pickup. */
  offline: boolean;
}

/**
 * Which payment controls checkout should render.
 *
 * ★ DELIVERY IS UNTOUCHED BY THE PICKUP POLICY. A merchant who requires
 * prepayment for collections has said nothing about their courier orders, and
 * silently switching COD off for those would be a policy they never set.
 */
export function paymentOptionsFor(input: PaymentOptionsInput): PaymentOptions {
  if (input.fulfilment === "delivery") {
    return { online: input.onlineAvailable, offline: true };
  }
  switch (input.policy) {
    case "prepaid":
      // ★ NO FALLBACK TO PAY-AT-STORE WHEN THE GATEWAY IS MISSING. That would
      // quietly serve the opposite of the merchant's policy. The store-side
      // guard (`canRequirePrepaid`) is what stops this state existing; if it
      // somehow does, offering nothing is the honest answer and the shopper is
      // told, rather than charged in a way the merchant refused.
      return { online: input.onlineAvailable, offline: false };
    case "at_store":
      return { online: false, offline: true };
    default:
      return { online: input.onlineAvailable, offline: true };
  }
}

/**
 * The payment methods in their storefront display order.
 *
 * Online leads whenever the store can actually take it; otherwise it is absent
 * rather than rendered as a dead choice. Keeping the order in the same pure
 * policy as availability and the default means those three promises cannot
 * drift apart in the checkout component.
 */
export function paymentMethodsFor(
  input: PaymentOptionsInput,
): CheckoutPaymentMethod[] {
  const opts = paymentOptionsFor(input);
  const methods: CheckoutPaymentMethod[] = [];
  if (opts.online) methods.push("razorpay");
  if (opts.offline) {
    methods.push(input.fulfilment === "pickup" ? "pay_at_store" : "cod");
  }
  return methods;
}

/**
 * Is `method` allowed for this order? The server's question.
 *
 * Note `cod` and `pay_at_store` are the same DECISION expressed differently —
 * checkout sends `pay_at_store` for a collection and `cod` for a delivery — so
 * both map onto `offline`.
 */
export function isPaymentMethodAllowed(
  method: CheckoutPaymentMethod,
  input: PaymentOptionsInput,
): boolean {
  const opts = paymentOptionsFor(input);
  if (method === "razorpay") return opts.online;
  // A delivery can never be paid at a store counter, and a collection is never
  // "cash on delivery" — there is no delivery. placeOrder checks the pairing
  // separately, but keeping it here means the two can't disagree.
  if (method === "pay_at_store") {
    return input.fulfilment === "pickup" && opts.offline;
  }
  return input.fulfilment === "delivery" && opts.offline;
}

/**
 * Which method should be PRE-SELECTED.
 *
 * ★ ONLINE WHEN IT IS AVAILABLE. The default used to be a hardcoded `cod`, so
 * every merchant who connected a gateway still watched shoppers land on Cash on
 * Delivery — the option that costs them a courier round trip and a collection
 * risk, chosen for them by us. Returns null when nothing can be offered, which
 * the caller must render as an explanation rather than an empty section.
 */
export function defaultPaymentMethod(
  input: PaymentOptionsInput,
): CheckoutPaymentMethod | null {
  return paymentMethodsFor(input)[0] ?? null;
}

/**
 * May this store require prepayment for collections?
 *
 * ★ `prepaid` WITHOUT A GATEWAY MAKES PICKUP UNORDERABLE — every collection
 * would need an online payment the store cannot take. Refused where the setting
 * is SAVED, so the broken state never exists, rather than discovered by a
 * shopper at checkout.
 */
export function canRequirePrepaid(onlineAvailable: boolean): boolean {
  return onlineAvailable;
}
