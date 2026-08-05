import { Store } from "lucide-react";

/**
 * How the DASHBOARD says a collection is going.
 *
 * Merchant vocabulary, deliberately not the shopper's: a shopper reads "Ready
 * to collect" as a promise about their own trip, while the person packing it
 * wants the stage of the job. Same reason `CUSTOMER_STATUS_LABEL` is kept apart
 * from the dashboard's `ORDER_STATUSES`.
 */
export const PICKUP_STAGE: Record<string, string> = {
  awaiting: "To pack",
  ready: "Ready",
  collected: "Collected",
  expired: "Not collected",
};

export function pickupStageLabel(status: string | null | undefined): string {
  return status ? (PICKUP_STAGE[status] ?? status) : "";
}

export function isPickupOrder(order: { fulfilment_type?: unknown }): boolean {
  return order.fulfilment_type === "pickup";
}

/**
 * "Pickup" on the row itself.
 *
 * The status pill can't carry it — "pending" looks identical whether a courier
 * is collecting it or the customer is walking in — so office staff had no way
 * to tell the two apart anywhere outside `/pos/pickups`.
 */
export function PickupBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700 ring-1 ring-inset ring-teal-600/20 ${className}`}
    >
      <Store size={11} aria-hidden />
      Pickup
    </span>
  );
}
