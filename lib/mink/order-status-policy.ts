export const MINK_ORDER_STATUS_TARGETS = [
  "processing",
  "shipped",
  "delivered",
] as const;

export type MinkOrderStatusTarget = (typeof MINK_ORDER_STATUS_TARGETS)[number];

export interface MinkOrderTransitionFacts {
  status: string;
  salesChannel: string;
  fulfilmentType: string;
  paymentMethod: string;
  paymentStatus: string;
  cancellationStatus: string | null;
  shipmentStatus: string | null;
}

export type MinkOrderTransitionDecision =
  | { allowed: true; targetStatus: MinkOrderStatusTarget }
  | { allowed: false; code: string; message: string };

const NEXT_STATUS: Partial<Record<string, MinkOrderStatusTarget>> = {
  pending: "processing",
  processing: "shipped",
  shipped: "delivered",
};

const SHIPMENT_EXCEPTIONS = new Set([
  "ndr",
  "rto_initiated",
  "rto_in_transit",
  "rto_delivered",
  "cancelled",
  "lost",
  "damaged",
]);

const SHIPMENT_PROVES_SHIPPED = new Set([
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
]);

/**
 * Deliberately narrow Phase 5C lifecycle policy. It is pure so preview and
 * execution can run the exact same rules after separate database reads.
 */
export function evaluateMinkOrderTransition(
  order: MinkOrderTransitionFacts,
  requestedTarget: unknown,
): MinkOrderTransitionDecision {
  if (
    typeof requestedTarget !== "string" ||
    !MINK_ORDER_STATUS_TARGETS.includes(
      requestedTarget as MinkOrderStatusTarget,
    )
  ) {
    return denied(
      "mink_order_target_invalid",
      "Mink can propose only processing, shipped or delivered for an eligible delivery order.",
    );
  }
  const targetStatus = requestedTarget as MinkOrderStatusTarget;
  const requiredNext = NEXT_STATUS[order.status];
  if (!requiredNext) {
    return denied(
      "mink_order_lifecycle_unsupported",
      "This order is not at a Phase 5C status that Mink can advance. Use the Orders workflow for cancellations, completed orders or exceptional states.",
    );
  }
  if (targetStatus !== requiredNext) {
    return denied(
      "mink_order_transition_invalid",
      `Mink can advance this order only one step from ${order.status} to ${requiredNext}.`,
    );
  }
  if (order.salesChannel !== "online") {
    return denied(
      "mink_order_channel_unsupported",
      "Mink order-status transitions are limited to online orders. POS sales use the register lifecycle.",
    );
  }
  if (order.fulfilmentType !== "delivery") {
    return denied(
      "mink_order_fulfilment_unsupported",
      "Mink order-status transitions are limited to delivery orders. Pickup orders use the collection workflow.",
    );
  }
  if (order.cancellationStatus === "requested") {
    return denied(
      "mink_order_cancellation_pending",
      "This order has a pending cancellation request. Decide that request in Orders before changing fulfilment status.",
    );
  }
  if (order.cancellationStatus && order.cancellationStatus !== "declined") {
    return denied(
      "mink_order_cancellation_state",
      "This order has a cancellation outcome that Mink cannot override. Review it in Orders before changing fulfilment status.",
    );
  }
  if (
    order.paymentStatus === "refunded" ||
    order.paymentStatus === "partially_refunded"
  ) {
    return denied(
      "mink_order_payment_refunded",
      "This order has refund activity and cannot be advanced by Mink. Review payment and fulfilment in Orders.",
    );
  }
  if (
    order.paymentMethod !== "cash_on_delivery" &&
    order.paymentStatus !== "paid"
  ) {
    return denied(
      "mink_order_payment_unsettled",
      "This non-COD order is not paid. Resolve payment in Orders before advancing fulfilment.",
    );
  }
  if (order.paymentStatus === "failed") {
    return denied(
      "mink_order_payment_failed",
      "This order has a failed payment and cannot be advanced by Mink.",
    );
  }
  if (order.shipmentStatus && SHIPMENT_EXCEPTIONS.has(order.shipmentStatus)) {
    return denied(
      "mink_order_shipment_exception",
      "The linked shipment is in an exception or terminal return state. Resolve it in the shipment workflow instead of changing the order through Mink.",
    );
  }
  if (
    targetStatus === "shipped" &&
    order.shipmentStatus &&
    !SHIPMENT_PROVES_SHIPPED.has(order.shipmentStatus)
  ) {
    return denied(
      "mink_order_shipment_not_collected",
      "The linked carrier shipment has not confirmed pickup or transit. Wait for the shipment workflow before marking the order shipped.",
    );
  }
  if (
    targetStatus === "delivered" &&
    order.shipmentStatus &&
    order.shipmentStatus !== "delivered"
  ) {
    return denied(
      "mink_order_shipment_not_delivered",
      "The linked carrier shipment has not confirmed delivery. Wait for carrier tracking or resolve the shipment manually.",
    );
  }
  return { allowed: true, targetStatus };
}

export function nextMinkOrderStatus(
  status: string,
): MinkOrderStatusTarget | null {
  return NEXT_STATUS[status] ?? null;
}

function denied(code: string, message: string): MinkOrderTransitionDecision {
  return { allowed: false, code, message };
}
