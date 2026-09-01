import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import {
  executeMinkOrderStatusAction,
  previewMinkOrderStatusAction,
} from "@/lib/mink/order-status-actions";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { emitEvent } from "@/lib/notifications/record";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

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
      { error: "Mink order-status request is too large." },
      { status: 413 },
    );
  }
  let mutation: ActionMutation;
  try {
    mutation = readMutation(await readBoundedJson(request));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof BodyTooLargeError
            ? "Mink order-status request is too large."
            : error instanceof Error
              ? error.message
              : "Invalid order-status action request.",
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
      `mink-order-status-action:${actor.storeId}:${actor.adminId}`,
      { max: 6, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink order-status actions are receiving too many requests." },
        { status: 429 },
      );
    }
    if (mutation.action === "preview") {
      const approval = await previewMinkOrderStatusAction({
        actor,
        draftId,
        expectedDraftVersion: mutation.expectedDraftVersion,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }
    const execution = await executeMinkOrderStatusAction({
      actor,
      draftId,
      approvalId: mutation.approvalId,
    });
    const { eventCustomerId, ...result } = execution;
    revalidatePath("/dashboard/orders");
    revalidatePath(result.approval.resource.dashboardPath);
    if (!result.repeated) {
      emitEvent({
        type: "order.status_changed",
        storeId: actor.storeId,
        actor: { type: "admin", id: actor.adminId, label: actor.email },
        subject: {
          type: "order",
          id: result.approval.resource.id,
          label: result.approval.resource.label,
        },
        customerId: eventCustomerId,
        payload: {
          status: result.approval.after.status,
          source: "mink_ai",
          approvalId: result.approval.id,
        },
      });
    }
    return privateJson({ result });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.order_status_action: request rejected", {
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
    logError("mink.order_status_action: request failed", error, {
      requestId,
      draftId,
      action: mutation.action,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't complete that order-status action." },
      { status: 503 },
    );
  }
}

type ActionMutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string };

function readMutation(value: unknown): ActionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Mink order-status request must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  if (row.action === "preview") {
    assertOnlyKeys(row, ["action", "expectedDraftVersion", "idempotencyKey"]);
    if (
      !Number.isInteger(row.expectedDraftVersion) ||
      Number(row.expectedDraftVersion) < 1
    ) {
      throw new SyntaxError("Save the private proposal before reviewing it.");
    }
    return {
      action: "preview",
      expectedDraftVersion: Number(row.expectedDraftVersion),
      idempotencyKey: readUuid(row.idempotencyKey, "idempotencyKey"),
    };
  }
  if (row.action === "execute") {
    assertOnlyKeys(row, ["action", "approvalId"]);
    return {
      action: "execute",
      approvalId: readUuid(row.approvalId, "approvalId"),
    };
  }
  throw new SyntaxError("Unknown Mink order-status action request.");
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body)
    throw new SyntaxError("Mink order-status request is empty.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

function readUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyntaxError(`${label} must be a UUID.`);
  }
  return value;
}

function assertOnlyKeys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Mink order-status request has unsupported fields.");
  }
}

function privateJson(value: unknown) {
  return NextResponse.json(value, {
    headers: { "Cache-Control": "no-store, private" },
  });
}
