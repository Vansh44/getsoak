import { describe, expect, it, vi } from "vitest";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext } from "../types";
import { MinkToolRegistry, type MinkTool } from "./registry";

function actor(overrides: Partial<MinkActorContext> = {}): MinkActorContext {
  return {
    storeId: "store-1",
    adminId: "admin-1",
    email: "owner@example.com",
    roleSlug: "member",
    permissions: {},
    isSuperadmin: false,
    effectivePlan: "pro",
    requestId: "request-1",
    ...overrides,
  };
}

function tool(overrides: Partial<MinkTool> = {}): MinkTool {
  return {
    declaration: {
      name: "read_products",
      description: "Read products.",
      parametersJsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    permission: { section: "products", action: "view" },
    execute: vi.fn(async (ctx) => ({ storeIdUsed: ctx.storeId })),
    ...overrides,
  };
}

describe("MinkToolRegistry", () => {
  it("only declares tools allowed by trusted actor permissions", () => {
    const registry = new MinkToolRegistry([tool()]);

    expect(registry.declarationsFor(actor())).toEqual([]);
    expect(
      registry.declarationsFor(
        actor({ permissions: { products: ["manage"] } }),
      ),
    ).toHaveLength(1);
  });

  it("rechecks permissions when a hidden tool name is submitted directly", async () => {
    const execute = vi.fn(async () => ({ secret: "should not run" }));
    const registry = new MinkToolRegistry([tool({ execute })]);

    const response = await registry.execute(actor(), {
      id: "call-1",
      name: "read_products",
      args: { storeId: "other-store" },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: "call-1",
      name: "read_products",
      response: {
        error: {
          code: "permission_denied",
          message: "The current admin is not allowed to use this tool.",
        },
      },
    });
  });

  it("passes the server actor unchanged and converts input errors safely", async () => {
    const execute = vi.fn(async (ctx: MinkActorContext) => {
      expect(ctx.storeId).toBe("store-1");
      throw new MinkToolInputError("query is invalid.");
    });
    const registry = new MinkToolRegistry([tool({ execute })]);
    const trustedActor = actor({ permissions: { products: ["view"] } });

    const response = await registry.execute(trustedActor, {
      name: "read_products",
      args: { storeId: "other-store" },
    });

    expect(execute).toHaveBeenCalledWith(trustedActor, {
      storeId: "other-store",
    });
    expect(response.response).toEqual({
      error: { code: "invalid_tool_input", message: "query is invalid." },
    });
  });

  it("rejects duplicate names so one tool cannot shadow another", () => {
    expect(() => new MinkToolRegistry([tool(), tool()])).toThrow(
      "Duplicate Mink tool: read_products",
    );
  });
});
