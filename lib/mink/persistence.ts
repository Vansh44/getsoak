import "server-only";

import { and, desc, eq, gt } from "drizzle-orm";
import {
  minkConversations,
  minkMessages,
  minkRuns,
  minkToolCalls,
  minkUsageLedger,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";
import type { MinkActorContext, MinkRunResult, MinkToolCall } from "./types";

const HISTORY_MESSAGES = 12;

export interface MinkStoredMessage {
  role: "user" | "assistant";
  text: string;
}

export interface MinkStartedRun {
  conversationId: string;
  runId: string;
  history: MinkStoredMessage[];
}

export async function startMinkRun(input: {
  actor: MinkActorContext;
  conversationId?: string;
  message: string;
  model: string;
}): Promise<MinkStartedRun> {
  const { actor, message, model } = input;
  const now = new Date().toISOString();

  return withService(async (db) => {
    let conversationId = input.conversationId;
    if (conversationId) {
      const existing = await db
        .select({ id: minkConversations.id })
        .from(minkConversations)
        .where(
          and(
            eq(minkConversations.id, conversationId),
            eq(minkConversations.storeId, actor.storeId),
            eq(minkConversations.adminId, actor.adminId),
            eq(minkConversations.status, "active"),
            gt(minkConversations.expiresAt, now),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        throw new MinkRequestError(
          "conversation_not_found",
          "That Mink AI conversation is no longer available. Start a new conversation.",
          404,
        );
      }
    } else {
      const created = await db
        .insert(minkConversations)
        .values({
          storeId: actor.storeId,
          adminId: actor.adminId,
          title: conversationTitle(message),
        })
        .returning({ id: minkConversations.id });
      conversationId = created[0]?.id;
      if (!conversationId)
        throw new Error("Mink conversation insert returned no id");
    }

    const previous = await db
      .select({
        role: minkMessages.role,
        content: minkMessages.contentJson,
      })
      .from(minkMessages)
      .innerJoin(
        minkRuns,
        and(
          eq(minkRuns.id, minkMessages.runId),
          eq(minkRuns.storeId, minkMessages.storeId),
          eq(minkRuns.status, "succeeded"),
        ),
      )
      .where(
        and(
          eq(minkMessages.storeId, actor.storeId),
          eq(minkMessages.conversationId, conversationId),
        ),
      )
      .orderBy(desc(minkMessages.createdAt), desc(minkMessages.id))
      .limit(HISTORY_MESSAGES);

    const createdRuns = await db
      .insert(minkRuns)
      .values({
        storeId: actor.storeId,
        conversationId,
        requestedBy: actor.adminId,
        requestId: actor.requestId,
        model,
      })
      .returning({ id: minkRuns.id });
    const runId = createdRuns[0]?.id;
    if (!runId) throw new Error("Mink run insert returned no id");

    await db.insert(minkMessages).values({
      storeId: actor.storeId,
      conversationId,
      runId,
      role: "user",
      contentJson: { text: message },
      model: null,
    });
    await db
      .update(minkConversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(
        and(
          eq(minkConversations.id, conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      );

    return {
      conversationId,
      runId,
      history: previous.reverse().flatMap(toStoredMessage),
    };
  });
}

export async function completeMinkRun(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  result: MinkRunResult;
  latencyMs: number;
}): Promise<void> {
  const { actor, started, result } = input;
  const completedAt = new Date().toISOString();
  await withService(async (db) => {
    const updated = await db
      .update(minkRuns)
      .set({
        status: "succeeded",
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.outputTokens,
        thoughtTokens: result.usage.thoughtTokens,
        totalTokens: result.usage.totalTokens,
        stepCount: result.steps,
        toolCallCount: result.toolCalls,
        latencyMs: input.latencyMs,
        completedAt,
      })
      .where(
        and(
          eq(minkRuns.id, started.runId),
          eq(minkRuns.storeId, actor.storeId),
          eq(minkRuns.requestedBy, actor.adminId),
          eq(minkRuns.status, "running"),
        ),
      )
      .returning({ id: minkRuns.id });
    if (!updated[0]) throw new Error("Mink run was not in a completable state");

    await db.insert(minkMessages).values({
      storeId: actor.storeId,
      conversationId: started.conversationId,
      runId: started.runId,
      role: "assistant",
      contentJson: { text: result.text },
      model: result.model,
    });
    await db.insert(minkUsageLedger).values({
      storeId: actor.storeId,
      adminId: actor.adminId,
      runId: started.runId,
      model: result.model,
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.outputTokens,
      thoughtTokens: result.usage.thoughtTokens,
      totalTokens: result.usage.totalTokens,
      // Phase 1 records shadow usage only. Billing begins after pilot data sets
      // the documented weights and an atomic reservation/reconciliation flow.
      chargedCredits: 0,
    });
    await db
      .update(minkConversations)
      .set({ lastMessageAt: completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(minkConversations.id, started.conversationId),
          eq(minkConversations.storeId, actor.storeId),
          eq(minkConversations.adminId, actor.adminId),
        ),
      );
  });
}

export async function failMinkRun(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  status: "failed" | "cancelled";
  errorCode: string;
  latencyMs: number;
}): Promise<void> {
  const completedAt = new Date().toISOString();
  await withService(async (db) => {
    await db
      .update(minkToolCalls)
      .set({
        status: "failed",
        resultSummary: { ok: false },
        errorCode: input.status === "cancelled" ? "cancelled" : "run_failed",
        completedAt,
      })
      .where(
        and(
          eq(minkToolCalls.storeId, input.actor.storeId),
          eq(minkToolCalls.runId, input.started.runId),
          eq(minkToolCalls.status, "running"),
        ),
      );
    await db
      .update(minkRuns)
      .set({
        status: input.status,
        errorCode: safeErrorCode(input.errorCode),
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        completedAt,
      })
      .where(
        and(
          eq(minkRuns.id, input.started.runId),
          eq(minkRuns.storeId, input.actor.storeId),
          eq(minkRuns.requestedBy, input.actor.adminId),
          eq(minkRuns.status, "running"),
        ),
      );
  });
}

export async function startMinkToolCall(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  sequence: number;
  call: MinkToolCall;
}): Promise<void> {
  await withService((db) =>
    db.insert(minkToolCalls).values({
      storeId: input.actor.storeId,
      runId: input.started.runId,
      sequence: input.sequence,
      providerCallId: input.call.id ?? null,
      toolName: input.call.name,
      // Arguments intentionally stay redacted in the alpha ledger. The model
      // receives them, but telemetry never needs a product search phrase.
      argumentsSummary: {},
    }),
  );
}

export async function completeMinkToolCall(input: {
  actor: MinkActorContext;
  started: MinkStartedRun;
  sequence: number;
  ok: boolean;
  errorCode?: string;
}): Promise<void> {
  const completedAt = new Date().toISOString();
  await withService((db) =>
    db
      .update(minkToolCalls)
      .set({
        status: input.ok ? "succeeded" : "failed",
        resultSummary: { ok: input.ok },
        errorCode: input.errorCode ? safeErrorCode(input.errorCode) : null,
        completedAt,
      })
      .where(
        and(
          eq(minkToolCalls.storeId, input.actor.storeId),
          eq(minkToolCalls.runId, input.started.runId),
          eq(minkToolCalls.sequence, input.sequence),
          eq(minkToolCalls.status, "running"),
        ),
      ),
  );
}

export function conversationTitle(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= 80) return compact;
  return `${characters.slice(0, 77).join("").trimEnd()}…`;
}

function toStoredMessage(row: {
  role: string;
  content: unknown;
}): MinkStoredMessage[] {
  if (row.role !== "user" && row.role !== "assistant") return [];
  if (!row.content || typeof row.content !== "object") return [];
  const text = (row.content as Record<string, unknown>).text;
  if (typeof text !== "string" || !text.trim()) return [];
  return [{ role: row.role, text }];
}

function safeErrorCode(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return normalized || "mink_failed";
}
