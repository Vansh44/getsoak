import { describe, expect, it, vi } from "vitest";
import type { MinkConfig } from "./config";
import { runMinkAgent } from "./orchestrator";
import type {
  MinkActorContext,
  MinkModelSession,
  MinkModelTurn,
  MinkUsage,
} from "./types";
import { MinkToolRegistry } from "./tools/registry";

const ZERO_USAGE: MinkUsage = {
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
};

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  requestId: "request-1",
};

function config(overrides: Partial<MinkConfig> = {}): MinkConfig {
  return {
    enabled: true,
    projectId: "project-1",
    location: "global",
    model: "gemini-3.7-flash",
    maxSteps: 8,
    maxToolCalls: 16,
    maxParallelReadTools: 4,
    maxOutputTokens: 2_048,
    ...overrides,
  };
}

function turn(overrides: Partial<MinkModelTurn> = {}): MinkModelTurn {
  return { text: "", functionCalls: [], usage: ZERO_USAGE, ...overrides };
}

function registry() {
  return new MinkToolRegistry([
    {
      declaration: {
        name: "get_store_profile",
        description: "Read store.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      permission: { section: "dashboard", action: "view" },
      execute: vi.fn(async (actor) => ({ storeId: actor.storeId })),
    },
  ]);
}

describe("runMinkAgent", () => {
  it("executes model-selected reads, returns results, and accumulates usage", async () => {
    const sendToolResponses = vi.fn(async () =>
      turn({
        text: "Your store is ready.",
        usage: {
          promptTokens: 20,
          outputTokens: 5,
          thoughtTokens: 2,
          totalTokens: 27,
        },
      }),
    );
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [
            { id: "call-1", name: "get_store_profile", args: {} },
          ],
          usage: {
            promptTokens: 10,
            outputTokens: 3,
            thoughtTokens: 1,
            totalTokens: 14,
          },
        }),
      ),
      sendToolResponses,
    };
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "How is my store?",
      config: config(),
      registry: registry(),
      session,
      onEvent,
    });

    expect(sendToolResponses).toHaveBeenCalledWith([
      {
        id: "call-1",
        name: "get_store_profile",
        response: { output: { storeId: "store-1" } },
      },
    ]);
    expect(result).toEqual({
      text: "Your store is ready.",
      model: "gemini-3.7-flash",
      steps: 2,
      toolCalls: 1,
      usage: {
        promptTokens: 30,
        outputTokens: 8,
        thoughtTokens: 3,
        totalTokens: 41,
      },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_call",
      sequence: 1,
      call: { id: "call-1", name: "get_store_profile", args: {} },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_result",
      sequence: 1,
      name: "get_store_profile",
      ok: true,
    });
  });

  it("stops before exceeding the reasoning-step cap", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "get_store_profile", args: {} }],
        }),
      ),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Keep reading forever.",
        config: config({ maxSteps: 1 }),
        registry: registry(),
        session,
      }),
    ).rejects.toMatchObject({ code: "step_limit_reached" });
    expect(session.sendToolResponses).not.toHaveBeenCalled();
  });

  it("rejects an empty final answer", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () => turn()),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Hello",
        config: config(),
        registry: registry(),
        session,
      }),
    ).rejects.toMatchObject({ code: "empty_model_response" });
  });
});
