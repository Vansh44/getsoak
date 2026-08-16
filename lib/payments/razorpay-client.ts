"use client";

// Client-side loader for Razorpay Standard Checkout (checkout.js) + a typed
// wrapper for opening the payment modal. Shared by the storefront checkout
// (BYO store gateway) and the dashboard AI-credits purchase (platform
// account). No secrets here — only the public key id ever reaches the client.

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

export interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

// Subscription (autopay) checkout returns the subscription id instead of an
// order id, and the signature is over payment_id|subscription_id.
export interface RazorpaySubscriptionSuccess {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  amount?: number; // paise (one-time only; subscriptions charge the plan amount)
  currency?: "INR";
  name: string;
  description?: string;
  order_id?: string;
  /** Required by Razorpay Checkout when an order is also registering a
   * recurring mandate. Harmlessly omitted for ordinary one-time orders. */
  customer_id?: string;
  subscription_id?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  handler: (response: RazorpaySuccess & RazorpaySubscriptionSuccess) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
}

interface RazorpayInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let loadPromise: Promise<boolean> | null = null;

/** Load checkout.js once; resolves false when the script can't load. */
export function loadRazorpayCheckout(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(!!window.Razorpay);
    script.onerror = () => {
      loadPromise = null; // allow a retry after a network blip
      resolve(false);
    };
    document.body.appendChild(script);
  });
  return loadPromise;
}

export interface OpenPaymentParams {
  keyId: string;
  rzpOrderId: string;
  amountPaise: number;
  customerId?: string;
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  themeColor?: string;
  onSuccess: (response: RazorpaySuccess) => void;
  onDismiss: () => void;
}

/** Open the Razorpay modal. Resolves false when checkout.js is unavailable
 *  (blocked network / extension) — the caller should surface an error. */
export async function openRazorpayModal(
  params: OpenPaymentParams,
): Promise<boolean> {
  const ready = await loadRazorpayCheckout();
  if (!ready || !window.Razorpay) return false;
  const rzp = new window.Razorpay({
    key: params.keyId,
    amount: params.amountPaise,
    currency: "INR",
    name: params.name,
    description: params.description,
    order_id: params.rzpOrderId,
    customer_id: params.customerId,
    prefill: params.prefill,
    handler: params.onSuccess,
    modal: { ondismiss: params.onDismiss },
    theme: params.themeColor ? { color: params.themeColor } : undefined,
  });
  rzp.open();
  return true;
}

export interface OpenSubscriptionParams {
  keyId: string;
  subscriptionId: string;
  name: string;
  description?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  themeColor?: string;
  onSuccess: (response: RazorpaySubscriptionSuccess) => void;
  onDismiss: () => void;
}

/** Open the Razorpay modal to authorise an autopay MANDATE for a subscription.
 *  Resolves false when checkout.js is unavailable. */
export async function openRazorpaySubscriptionModal(
  params: OpenSubscriptionParams,
): Promise<boolean> {
  const ready = await loadRazorpayCheckout();
  if (!ready || !window.Razorpay) return false;
  const rzp = new window.Razorpay({
    key: params.keyId,
    name: params.name,
    description: params.description,
    subscription_id: params.subscriptionId,
    prefill: params.prefill,
    handler: params.onSuccess,
    modal: { ondismiss: params.onDismiss },
    theme: params.themeColor ? { color: params.themeColor } : undefined,
  });
  rzp.open();
  return true;
}
