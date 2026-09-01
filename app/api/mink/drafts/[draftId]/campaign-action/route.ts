import { after, NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import {
  executeMinkCampaign,
  getMinkCampaignAudienceOptions,
  previewMinkCampaign,
} from "@/lib/mink/campaign-actions";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4_096;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const { draftId } = await params;
  if (!UUID_PATTERN.test(draftId)) {
    return NextResponse.json(
      { error: "Invalid Mink AI draft." },
      { status: 400 },
    );
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Mink campaign request is too large." },
      { status: 413 },
    );
  }
  let mutation: CampaignMutation;
  try {
    mutation = readMutation(await readBoundedJson(request));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof BodyTooLargeError
            ? "Mink campaign request is too large."
            : error instanceof Error
              ? error.message
              : "Invalid campaign request.",
      },
      { status: error instanceof BodyTooLargeError ? 413 : 400 },
    );
  }
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-campaign-action:${actor.storeId}:${actor.adminId}`,
      { max: 4, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink campaign actions are receiving too many requests." },
        { status: 429 },
      );
    }
    if (mutation.action === "options") {
      return privateJson({
        options: await getMinkCampaignAudienceOptions(actor, draftId),
      });
    }
    if (mutation.action === "preview") {
      return privateJson({
        approval: await previewMinkCampaign({
          actor,
          draftId,
          expectedDraftVersion: mutation.expectedDraftVersion,
          idempotencyKey: mutation.idempotencyKey,
          audienceMode: mutation.audienceMode,
          groupId: mutation.groupId,
          mode: mutation.mode,
          scheduledFor: mutation.scheduledFor,
        }),
      });
    }
    const execution = await executeMinkCampaign({
      actor,
      draftId,
      approvalId: mutation.approvalId,
    });
    const { triggerWorker, ...result } = execution;
    if (triggerWorker) after(() => triggerEmailWorker());
    return privateJson({ result });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.campaign_action: request rejected", {
        requestId,
        draftId,
        action: mutation.action,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.campaign_action: request failed", error, {
      requestId,
      draftId,
      action: mutation.action,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't complete that campaign action." },
      { status: 503 },
    );
  }
}

type CampaignMutation =
  | { action: "options" }
  | {
      action: "preview";
      expectedDraftVersion: number;
      idempotencyKey: string;
      audienceMode: "all" | "group";
      groupId?: string;
      mode: "send_now" | "schedule";
      scheduledFor?: string;
    }
  | { action: "execute"; approvalId: string };

function readMutation(value: unknown): CampaignMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Mink campaign action must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  if (row.action === "options") {
    assertOnlyKeys(row, ["action"]);
    return { action: "options" };
  }
  if (row.action === "preview") {
    assertOnlyKeys(row, [
      "action",
      "expectedDraftVersion",
      "idempotencyKey",
      "audienceMode",
      "groupId",
      "mode",
      "scheduledFor",
    ]);
    if (
      !Number.isInteger(row.expectedDraftVersion) ||
      Number(row.expectedDraftVersion) < 1
    ) {
      throw new SyntaxError("Save the private proposal before reviewing it.");
    }
    if (row.audienceMode !== "all" && row.audienceMode !== "group") {
      throw new SyntaxError("Choose all customers or one customer group.");
    }
    if (row.groupId !== undefined && typeof row.groupId !== "string") {
      throw new SyntaxError("The customer group must be a UUID.");
    }
    if (row.mode !== "send_now" && row.mode !== "schedule") {
      throw new SyntaxError("Choose Send now or Schedule for later.");
    }
    if (
      row.scheduledFor !== undefined &&
      typeof row.scheduledFor !== "string"
    ) {
      throw new SyntaxError("The scheduled send time must be text.");
    }
    return {
      action: "preview",
      expectedDraftVersion: Number(row.expectedDraftVersion),
      idempotencyKey: readUuid(row.idempotencyKey, "idempotencyKey"),
      audienceMode: row.audienceMode,
      ...(row.groupId === undefined
        ? {}
        : { groupId: readUuid(row.groupId, "groupId") }),
      mode: row.mode,
      ...(row.scheduledFor === undefined
        ? {}
        : { scheduledFor: row.scheduledFor }),
    };
  }
  if (row.action === "execute") {
    assertOnlyKeys(row, ["action", "approvalId"]);
    return {
      action: "execute",
      approvalId: readUuid(row.approvalId, "approvalId"),
    };
  }
  throw new SyntaxError("Unknown Mink campaign request.");
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Mink campaign request is empty.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let value = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    value += decoder.decode(chunk.value, { stream: true });
  }
  value += decoder.decode();
  return JSON.parse(value);
}

function readUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyntaxError(`${label} must be a UUID.`);
  }
  return value;
}

function assertOnlyKeys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Mink campaign action has unsupported fields.");
  }
}

function privateJson(value: unknown) {
  return NextResponse.json(value, {
    headers: { "Cache-Control": "no-store, private" },
  });
}
