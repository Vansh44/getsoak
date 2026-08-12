// Provider-neutral shipment lifecycle. Carrier vocabularies are translated at
// the boundary so the dashboard, customer page and notifications never learn
// Shiprocket's numeric codes.

export const SHIPMENT_STATUSES = [
  "draft",
  "booking",
  "ready_to_ship",
  "pickup_scheduled",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "ndr",
  "rto_initiated",
  "rto_in_transit",
  "rto_delivered",
  "cancelled",
  "lost",
  "damaged",
  "error",
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const CODE_STATUS: Record<number, ShipmentStatus> = {
  6: "picked_up",
  7: "delivered",
  8: "cancelled",
  9: "rto_initiated",
  10: "rto_delivered",
  12: "lost",
  13: "error",
  14: "rto_initiated",
  15: "pickup_scheduled",
  16: "cancelled",
  17: "out_for_delivery",
  18: "in_transit",
  19: "pickup_scheduled",
  20: "error",
  21: "ndr",
  22: "in_transit",
  23: "ndr", // StoreMink v1 has no partial delivery state.
  24: "damaged",
  25: "damaged",
  26: "ready_to_ship",
  27: "pickup_scheduled",
  38: "in_transit",
  39: "in_transit",
  40: "rto_initiated",
  41: "rto_in_transit",
  42: "picked_up",
  43: "picked_up",
  44: "cancelled",
  45: "cancelled",
  46: "rto_in_transit",
  47: "ndr",
  48: "in_transit",
};

/** Map Shiprocket's status id/name into StoreMink's stable vocabulary. */
export function mapShiprocketStatus(
  code: unknown,
  label: unknown,
): ShipmentStatus {
  const n = Number(code);
  if (Number.isFinite(n) && CODE_STATUS[n]) return CODE_STATUS[n];

  const s = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (/rto.*delivered|returned.*origin.*delivered/.test(s))
    return "rto_delivered";
  if (/rto.*(transit|ofd)|return.*origin.*transit/.test(s))
    return "rto_in_transit";
  if (/rto|return to origin/.test(s)) return "rto_initiated";
  if (/undelivered|ndr|attempted|qc failed/.test(s)) return "ndr";
  if (/delivered/.test(s)) return "delivered";
  if (/out for delivery/.test(s)) return "out_for_delivery";
  if (/lost/.test(s)) return "lost";
  if (/damaged|destroyed/.test(s)) return "damaged";
  if (/cancel/.test(s)) return "cancelled";
  if (/picked up|shipped|self fulfilled/.test(s)) return "picked_up";
  if (/in transit|destination hub|reached warehouse|misrouted|delayed/.test(s))
    return "in_transit";
  if (/pickup booked|out for pickup|pickup rescheduled/.test(s))
    return "pickup_scheduled";
  if (/ready to ship|fulfilled|awb assigned|label/.test(s))
    return "ready_to_ship";
  if (/error|exception/.test(s)) return "error";
  return "in_transit";
}

const TERMINAL = new Set<ShipmentStatus>([
  "delivered",
  "rto_delivered",
  "cancelled",
  "lost",
  "damaged",
]);

const FORWARD_RANK: Partial<Record<ShipmentStatus, number>> = {
  draft: 0,
  booking: 1,
  ready_to_ship: 2,
  pickup_scheduled: 3,
  picked_up: 4,
  in_transit: 5,
  out_for_delivery: 6,
  delivered: 7,
};

/**
 * Webhooks can be delayed or delivered out of order. Never regress the normal
 * journey or revive a terminal parcel. NDR and RTO are branches, so a reattempt
 * is explicitly allowed to rejoin in-transit/out-for-delivery.
 */
export function acceptShipmentTransition(
  current: ShipmentStatus,
  incoming: ShipmentStatus,
): ShipmentStatus {
  if (current === incoming) return current;
  if (TERMINAL.has(current)) return current;
  if (incoming.startsWith("rto_")) return incoming;
  if (current.startsWith("rto_")) {
    return incoming.startsWith("rto_") ? incoming : current;
  }
  if (current === "ndr") {
    return ["in_transit", "out_for_delivery", "ndr"].includes(incoming)
      ? incoming
      : current;
  }
  if (incoming === "ndr" || TERMINAL.has(incoming)) return incoming;
  if (current === "error") return incoming;

  const a = FORWARD_RANK[current];
  const b = FORWARD_RANK[incoming];
  return a !== undefined && b !== undefined && b < a ? current : incoming;
}

export function shipmentStatusLabel(status: ShipmentStatus): string {
  const labels: Record<ShipmentStatus, string> = {
    draft: "Draft",
    booking: "Booking courier",
    ready_to_ship: "Ready to ship",
    pickup_scheduled: "Pickup scheduled",
    picked_up: "Picked up",
    in_transit: "In transit",
    out_for_delivery: "Out for delivery",
    delivered: "Delivered",
    ndr: "Delivery action required",
    rto_initiated: "Returning to origin",
    rto_in_transit: "Return in transit",
    rto_delivered: "Returned to origin",
    cancelled: "Cancelled",
    lost: "Lost",
    damaged: "Damaged",
    error: "Carrier error",
  };
  return labels[status];
}
