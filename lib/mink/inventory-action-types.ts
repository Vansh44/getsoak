import type {
  MinkProductActionOperation,
  MinkProductActionStatus,
} from "./product-action-types";

export type MinkInventoryActionValues = Record<string, string | null>;

export interface MinkInventoryActionApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "adjust_inventory";
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "inventory";
    id: string;
    label: string;
    dashboardPath: string;
    productId: string;
    variantId: string | null;
    locationId: string;
  };
  before: MinkInventoryActionValues;
  after: MinkInventoryActionValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkInventoryActionResult {
  approval: MinkInventoryActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export const MINK_INVENTORY_ACTION_FIELDS = [
  "location",
  "sku",
  "on_hand",
  "available",
  "quantity_change",
  "resulting_on_hand",
  "reason",
  "note",
] as const;

export const MINK_INVENTORY_FIELD_LABELS: Record<string, string> = {
  location: "Location",
  sku: "SKU",
  on_hand: "On hand",
  available: "Available before adjustment",
  quantity_change: "Quantity change",
  resulting_on_hand: "Resulting on hand",
  reason: "Reason",
  note: "Audit note",
};
