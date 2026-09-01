import type {
  MinkProductActionOperation,
  MinkProductActionStatus,
} from "./product-action-types";

export interface MinkBulkInventoryActionLine {
  line: number;
  productId: string;
  variantId: string | null;
  locationId: string;
  product: string;
  variant: string | null;
  sku: string;
  location: string;
  onHand: number;
  reserved: number;
  available: number;
  quantityChange: number;
  resultingOnHand: number;
  resultingAvailable: number;
  reason: string;
  note: string;
}

export interface MinkBulkInventoryActionApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "bulk_adjust_inventory";
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "inventory_bulk";
    label: string;
    dashboardPath: string;
    lineCount: number;
  };
  lines: MinkBulkInventoryActionLine[];
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkBulkInventoryActionResult {
  approval: MinkBulkInventoryActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export interface MinkBulkInventoryValidationDetail {
  line: number;
  sku: string;
  location: string;
  code: string;
  message: string;
}
