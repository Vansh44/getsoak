import type { MinkProductActionStatus } from "./product-action-types";

export type MinkOrderStatusActionValues = Record<string, string | null>;

export interface MinkOrderStatusActionApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "transition_order_status";
  operation: "apply";
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "order";
    id: string;
    label: string;
    dashboardPath: string;
  };
  before: MinkOrderStatusActionValues;
  after: MinkOrderStatusActionValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkOrderStatusActionResult {
  approval: MinkOrderStatusActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export interface MinkOrderStatusExecutionResult extends MinkOrderStatusActionResult {
  /** Trusted event audience; stripped by the route before returning JSON. */
  eventCustomerId: string | null;
}

export const MINK_ORDER_STATUS_ACTION_FIELDS = [
  "status",
  "payment_status",
  "channel",
  "fulfilment",
  "location",
  "shipment_status",
  "note",
] as const;

export const MINK_ORDER_STATUS_FIELD_LABELS: Record<string, string> = {
  status: "Order status",
  payment_status: "Payment status",
  channel: "Sales channel",
  fulfilment: "Fulfilment type",
  location: "Location",
  shipment_status: "Latest shipment status",
  note: "Internal audit note",
};
