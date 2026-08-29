import type {
  PermissionAction,
  RolePermissions,
} from "@/app/dashboard/lib/permissions";

export type MinkPlan = "free" | "basic" | "pro";

/**
 * Trusted, server-derived identity for one Mink run. Model-generated input must
 * never be able to replace any field on this object.
 */
export interface MinkActorContext {
  storeId: string;
  adminId: string;
  email: string | null;
  roleSlug: string;
  permissions: RolePermissions;
  isSuperadmin: boolean;
  effectivePlan: MinkPlan;
  requestId: string;
}

export interface MinkToolPermission {
  section: string;
  action: PermissionAction;
}

export interface MinkToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface MinkToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface MinkToolResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface MinkUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface MinkModelTurn {
  text: string;
  functionCalls: MinkToolCall[];
  usage: MinkUsage;
}

export interface MinkModelSession {
  sendUserMessage(message: string): Promise<MinkModelTurn>;
  sendToolResponses(responses: MinkToolResponse[]): Promise<MinkModelTurn>;
}

export type MinkRunEvent =
  | { type: "tool_call"; sequence: number; call: MinkToolCall }
  | {
      type: "tool_result";
      sequence: number;
      name: string;
      ok: boolean;
      errorCode?: string;
    };

export interface MinkRunResult {
  text: string;
  model: string;
  steps: number;
  toolCalls: number;
  usage: MinkUsage;
}
