"use client";

import { useEffect } from "react";
import { reconcileMyOrderPayment } from "@/app/actions/checkout-actions";

/**
 * Online orders: reconcile-on-read (§18). If the client-side confirm call was
 * dropped — a network blip in the moment right after paying — this asks the
 * server to check Razorpay directly and mark the order paid. Fire-and-forget;
 * the reaper cron is the ultimate safety net.
 *
 * Its own component so the success page itself can be a SERVER component and
 * load the collection details into the first paint, rather than flashing an
 * order reference and filling in the address a round-trip later.
 */
export function ReconcilePayment({ orderId }: { orderId: string }) {
  useEffect(() => {
    reconcileMyOrderPayment(orderId).catch(() => {});
  }, [orderId]);
  return null;
}
