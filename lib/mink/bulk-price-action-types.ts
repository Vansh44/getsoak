import type {
  MinkProductActionOperation,
  MinkProductActionStatus,
} from "./product-action-types";

export interface MinkBulkPriceActionLine {
  line: number;
  productId: string;
  variantId: string | null;
  product: string;
  variant: string | null;
  sku: string;
  publicationStatus: string;
  before: {
    basePrice: string;
    sellingPrice: string;
    specialPrice: string | null;
    effectivePrice: string;
  };
  after: {
    basePrice: string;
    sellingPrice: string;
    specialPrice: string | null;
    effectivePrice: string;
  };
  effectiveChange: string;
  effectiveChangePercent: string;
}

export interface MinkBulkPriceImpactSummary {
  currency: "INR";
  basis: "one_unit_each";
  currentUnitBasket: string;
  proposedUnitBasket: string;
  change: string;
  changePercent: string;
  increases: number;
  decreases: number;
  unchangedEffective: number;
  publishedLines: number;
  note: string;
}

export interface MinkBulkPriceActionApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "bulk_update_prices";
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "price_bulk";
    label: string;
    dashboardPath: string;
    lineCount: number;
  };
  lines: MinkBulkPriceActionLine[];
  impact: MinkBulkPriceImpactSummary;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkBulkPriceActionResult {
  approval: MinkBulkPriceActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export interface MinkBulkPriceValidationDetail {
  line: number;
  sku: string;
  code: string;
  message: string;
}
