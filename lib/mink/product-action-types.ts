import type { MinkDraftContent } from "./draft-types";

export const MINK_PRODUCT_ACTION_TOOLS = [
  "apply_product_description",
  "apply_product_seo",
] as const;

export type MinkProductActionTool = (typeof MINK_PRODUCT_ACTION_TOOLS)[number];
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
