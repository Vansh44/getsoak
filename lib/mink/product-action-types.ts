import type { MinkDraftContent } from "./draft-types";

export const MINK_PRODUCT_ACTION_TOOLS = [
  "apply_product_description",
  "apply_product_seo",
] as const;

export const MINK_DOMAIN_ACTION_TOOLS = [
  "create_product",
  "create_coupon",
  "update_coupon",
  "create_customer_group",
  "update_customer_group",
] as const;

export const MINK_INVENTORY_ACTION_TOOLS = [
  "adjust_inventory",
  "bulk_adjust_inventory",
] as const;

export const MINK_ORDER_ACTION_TOOLS = ["transition_order_status"] as const;

export const MINK_ACTION_TOOLS = [
  ...MINK_PRODUCT_ACTION_TOOLS,
  ...MINK_DOMAIN_ACTION_TOOLS,
  ...MINK_INVENTORY_ACTION_TOOLS,
  ...MINK_ORDER_ACTION_TOOLS,
] as const;

export type MinkProductActionTool = (typeof MINK_PRODUCT_ACTION_TOOLS)[number];
export type MinkDomainActionTool = (typeof MINK_DOMAIN_ACTION_TOOLS)[number];
export type MinkInventoryActionTool =
  (typeof MINK_INVENTORY_ACTION_TOOLS)[number];
export type MinkOrderActionTool = (typeof MINK_ORDER_ACTION_TOOLS)[number];
export type MinkActionTool = (typeof MINK_ACTION_TOOLS)[number];
export type MinkProductActionOperation = "apply" | "rollback";
export type MinkProductActionStatus =
  | "pending"
  | "executed"
  | "conflicted"
  | "expired"
  | "cancelled";

export type MinkProductActionValues = Record<string, string | null>;

export interface MinkProductActionApproval {
  id: string;
  sourceApprovalId: string | null;
  toolName: MinkProductActionTool;
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  product: {
    id: string;
    name: string;
    slug: string;
    dashboardPath: string;
  };
  before: MinkProductActionValues;
  after: MinkProductActionValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkProductActionResult {
  approval: MinkProductActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export function isMinkProductActionTool(
  value: unknown,
): value is MinkProductActionTool {
  return MINK_PRODUCT_ACTION_TOOLS.includes(value as MinkProductActionTool);
}

export function isMinkDomainActionTool(
  value: unknown,
): value is MinkDomainActionTool {
  return MINK_DOMAIN_ACTION_TOOLS.includes(value as MinkDomainActionTool);
}

export function isMinkActionTool(value: unknown): value is MinkActionTool {
  return MINK_ACTION_TOOLS.includes(value as MinkActionTool);
}

export const MINK_ACTION_TOOL_LABELS: Record<MinkActionTool, string> = {
  apply_product_description: "Product descriptions",
  apply_product_seo: "Product SEO",
  create_product: "Draft product creation",
  create_coupon: "Disabled coupon creation",
  update_coupon: "Disabled coupon updates",
  create_customer_group: "Customer-group creation",
  update_customer_group: "Customer-group updates",
  adjust_inventory: "Single-SKU inventory adjustments",
  bulk_adjust_inventory: "Bulk inventory adjustments",
  transition_order_status: "Delivery order-status transitions",
};

export function actionToolForDraftKind(
  kind: string,
): MinkProductActionTool | null {
  if (kind === "product_description") return "apply_product_description";
  if (kind === "product_seo") return "apply_product_seo";
  return null;
}

export function actionFieldsForTool(
  tool: MinkProductActionTool,
): readonly string[] {
  return tool === "apply_product_description"
    ? ["description"]
    : ["seo_title", "seo_description"];
}

export function draftContentForAction(
  tool: MinkProductActionTool,
  content: MinkDraftContent,
): MinkProductActionValues {
  return Object.fromEntries(
    actionFieldsForTool(tool).map((field) => [field, content[field] ?? ""]),
  );
}
