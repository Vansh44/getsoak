import "server-only";

import { can } from "@/app/dashboard/lib/permissions";
import { logError } from "@/lib/observability/logger";
import { MinkToolInputError } from "../errors";
import type {
  MinkActorContext,
  MinkToolCall,
  MinkToolDeclaration,
  MinkToolPermission,
  MinkToolResponse,
} from "../types";

export interface MinkTool {
  declaration: MinkToolDeclaration;
  permission: MinkToolPermission;
  execute: (
    actor: MinkActorContext,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export class MinkToolRegistry {
  private readonly tools: Map<string, MinkTool>;

  constructor(tools: MinkTool[]) {
    this.tools = new Map();
    for (const tool of tools) {
      const name = tool.declaration.name;
      if (this.tools.has(name)) throw new Error(`Duplicate Mink tool: ${name}`);
      this.tools.set(name, tool);
    }
  }

  declarationsFor(actor: MinkActorContext): MinkToolDeclaration[] {
    return [...this.tools.values()]
      .filter((tool) => this.allowed(actor, tool))
      .map((tool) => tool.declaration);
  }

  async execute(
    actor: MinkActorContext,
    call: MinkToolCall,
  ): Promise<MinkToolResponse> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return failure(call, "unknown_tool", "That tool is not available.");
    }
    // The model only sees permitted declarations, but this check is the real
    // boundary. Never rely on tool visibility as authorization.
    if (!this.allowed(actor, tool)) {
      return failure(
        call,
        "permission_denied",
        "The current admin is not allowed to use this tool.",
      );
    }

    try {
      const output = await tool.execute(actor, call.args);
      return {
        id: call.id,
        name: call.name,
        response: { output },
      };
    } catch (error) {
      if (error instanceof MinkToolInputError) {
        return failure(call, "invalid_tool_input", error.message);
      }
      logError("mink.tool: failed", error, {
        requestId: actor.requestId,
        storeId: actor.storeId,
        adminId: actor.adminId,
        tool: call.name,
      });
      // Do not put database or stack details back into the model context.
      return failure(
        call,
        "tool_failed",
        "The store data could not be read right now.",
      );
    }
  }

  private allowed(actor: MinkActorContext, tool: MinkTool): boolean {
    return can(
      actor.permissions,
      tool.permission.section,
      tool.permission.action,
      actor.isSuperadmin,
    );
  }
}

function failure(
  call: MinkToolCall,
  code: string,
  message: string,
): MinkToolResponse {
  return {
    id: call.id,
    name: call.name,
    response: { error: { code, message } },
  };
}
