import type { MinkDraftContent } from "./draft-types";
import type {
  MinkDomainActionTool,
  MinkProductActionOperation,
  MinkProductActionStatus,
} from "./product-action-types";

export type MinkDomainResourceType = "product" | "coupon" | "customer_group";
export type MinkDomainActionValues = Record<string, string | null>;

export interface MinkDomainActionApproval {
  id: string;
  sourceApprovalId: string | null;
  toolName: MinkDomainActionTool;
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: MinkDomainResourceType;
    id: string | null;
    label: string;
    dashboardPath: string;
  };
  before: MinkDomainActionValues;
  after: MinkDomainActionValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkDomainActionResult {
  approval: MinkDomainActionApproval;
  auditId: string | null;
  repeated: boolean;
}

export function domainActionToolForDraftKind(
  kind: string,
): MinkDomainActionTool | null {
  if (kind === "product_create") return "create_product";
  if (kind === "coupon_create") return "create_coupon";
  if (kind === "coupon_update") return "update_coupon";
  if (kind === "customer_group_create") return "create_customer_group";
  if (kind === "customer_group_update") return "update_customer_group";
  return null;
}

export function resourceTypeForDomainTool(
  tool: MinkDomainActionTool,
): MinkDomainResourceType {
  if (tool === "create_product") return "product";
  if (tool === "create_coupon" || tool === "update_coupon") return "coupon";
  return "customer_group";
}

export function isCreateDomainTool(tool: MinkDomainActionTool) {
  return tool.startsWith("create_");
}

export function domainActionFields(
  tool: MinkDomainActionTool,
): readonly string[] {
  if (tool === "create_product") {
    return [
      "name",
      "slug",
      "description",
      "seo_title",
      "seo_description",
      "base_price",
      "selling_price",
      "status",
      "track_inventory",
    ];
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    return [
      "code",
      "description",
      "discount_type",
      "discount_value",
      "min_order_amount",
      "max_uses",
      "valid_from",
      "valid_until",
      "status",
      "show_on_storefront",
      "audience",
    ];
  }
  return ["name", "description", "color"];
}

export const MINK_DOMAIN_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  slug: "URL slug",
  description: "Description",
  seo_title: "SEO title",
  seo_description: "SEO description",
  base_price: "Base price (INR)",
  selling_price: "Selling price (INR)",
  status: "Status",
  track_inventory: "Inventory tracking",
  code: "Coupon code",
  discount_type: "Discount type",
  discount_value: "Discount value",
  min_order_amount: "Minimum order amount",
  max_uses: "Maximum uses",
  valid_from: "Valid from",
  valid_until: "Valid until",
  show_on_storefront: "Shown on storefront",
  audience: "Audience restrictions",
  color: "Colour",
};

export function draftValuesForDomainAction(
  tool: MinkDomainActionTool,
  content: MinkDraftContent,
): MinkDomainActionValues {
  const values: MinkDomainActionValues = Object.fromEntries(
    domainActionFields(tool).map((field) => [field, content[field] ?? null]),
  );
  if (tool === "create_product") {
    values.status = "draft";
    values.track_inventory = "disabled";
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    values.status = "disabled";
    values.show_on_storefront = "no";
    values.audience = "all customers (no group restriction)";
  }
  return values;
}
