import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import {
  executeMinkBulkPriceAction,
  MinkBulkPriceValidationError,
  previewMinkBulkPriceAction,
} from "@/lib/mink/bulk-price-actions";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { emitEvent } from "@/lib/notifications/record";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { TAGS } from "@/lib/storefront/tags";

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
      { error: "Mink bulk price request is too large." },
      { status: 413 },
    );
  }

  let mutation: ActionMutation;
  try {
    mutation = readMutation(await readBoundedJson(request));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return NextResponse.json(
        { error: "Mink bulk price request is too large." },
        { status: 413 },
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Invalid bulk price action request.",
      },
      { status: 400 },
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
      `mink-bulk-price-action:${actor.storeId}:${actor.adminId}`,
      { max: 4, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink bulk price actions are receiving too many requests." },
        { status: 429 },
      );
    }

    if (mutation.action === "preview") {
      const approval = await previewMinkBulkPriceAction({
        actor,
        draftId,
        expectedDraftVersion: mutation.expectedDraftVersion,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }

    const result = await executeMinkBulkPriceAction({
      actor,
      draftId,
      approvalId: mutation.approvalId,
    });
    invalidateProducts(result.approval.lines);
    if (!result.repeated) {
      for (const line of result.approval.lines) {
        emitEvent({
          type: "product.updated",
          storeId: actor.storeId,
          actor: { type: "admin", id: actor.adminId, label: actor.email },
          subject: {
            type: "product",
            id: line.productId,
            label: `${line.product}${line.variant ? ` · ${line.variant}` : ""}`,
          },
          payload: {
            source: "mink_ai_bulk_price",
            tool: "bulk_update_prices",
            approvalId: result.approval.id,
            line: line.line,
            sku: line.sku,
            beforeEffectivePrice: line.before.effectivePrice,
            afterEffectivePrice: line.after.effectivePrice,
          },
        });
      }
    }
    return privateJson({ result });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.bulk_price_action: request rejected", {
        requestId,
        draftId,
        action: mutation.action,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error instanceof MinkBulkPriceValidationError
            ? { lineErrors: error.lineErrors.slice(0, 20) }
            : {}),
        },
        { status: error.status },
      );
    }
    logError("mink.bulk_price_action: request failed", error, {
      requestId,
      draftId,
      action: mutation.action,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't complete that bulk price action." },
      { status: 503 },
    );
  }
}

function invalidateProducts(lines: Array<{ productId: string }>) {
  revalidatePath("/dashboard/products");
  revalidatePath("/shop");
  for (const productId of new Set(lines.map((line) => line.productId))) {
    revalidatePath(`/dashboard/products/${productId}`);
  }
  revalidateTag(TAGS.products, "max");
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) {
    throw new SyntaxError("Mink bulk price request is empty.");
  }
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

function privateJson(value: unknown) {
  return NextResponse.json(value, {
    headers: { "Cache-Control": "no-store, private" },
  });
}

type ActionMutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string };

function readMutation(value: unknown): ActionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Mink bulk price request must be a JSON object.");
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
  throw new SyntaxError("Unknown Mink bulk price action request.");
}

function readUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyntaxError(`${label} must be a UUID.`);
  }
  return value;
}

function assertOnlyKeys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Mink bulk price request has unsupported fields.");
  }
}
