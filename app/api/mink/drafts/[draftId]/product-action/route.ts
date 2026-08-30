import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import {
  executeMinkProductAction,
  previewMinkProductAction,
  previewMinkProductActionRollback,
} from "@/lib/mink/product-actions";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { emitEvent } from "@/lib/notifications/record";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { TAGS } from "@/lib/storefront/tags";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8_192;

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
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Product action request is too large." },
      { status: 413 },
    );
  }
  let mutation: ProductActionMutation;
  try {
    mutation = readMutation(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Invalid product action request.",
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
      `mink-product-action:${actor.storeId}:${actor.adminId}`,
      { max: 12, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink product actions are receiving too many requests." },
        { status: 429 },
      );
    }

    if (mutation.action === "preview") {
      const approval = await previewMinkProductAction({
        actor,
        draftId,
        expectedDraftVersion: mutation.expectedDraftVersion,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }
    if (mutation.action === "preview_rollback") {
      const approval = await previewMinkProductActionRollback({
        actor,
        draftId,
        sourceApprovalId: mutation.sourceApprovalId,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }

    const result = await executeMinkProductAction({
      actor,
      draftId,
      approvalId: mutation.approvalId,
    });
    invalidateProduct(result.approval.product.id, result.approval.product.slug);
    if (!result.repeated) {
      emitEvent({
        type: "product.updated",
        storeId: actor.storeId,
        actor: { type: "admin", id: actor.adminId, label: actor.email },
        subject: {
          type: "product",
          id: result.approval.product.id,
          label: result.approval.product.name,
        },
        payload: {
          source: "mink_ai",
          operation: result.approval.operation,
          tool: result.approval.toolName,
          approvalId: result.approval.id,
        },
      });
    }
    return privateJson({ result });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.product_action: request rejected", {
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
    logError("mink.product_action: request failed", error, {
      requestId,
      draftId,
      action: mutation.action,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't complete that product action." },
      { status: 503 },
    );
  }
}

function privateJson(value: unknown) {
  return NextResponse.json(value, {
    headers: { "Cache-Control": "no-store, private" },
  });
}

function invalidateProduct(productId: string, slug: string) {
  revalidatePath("/dashboard/products");
  revalidatePath(`/dashboard/products/${productId}`);
  revalidatePath("/shop");
  revalidatePath(`/shop/${slug}`);
  revalidateTag(TAGS.products, "max");
}

type ProductActionMutation =
  | {
      action: "preview";
      expectedDraftVersion: number;
      idempotencyKey: string;
    }
  | { action: "execute"; approvalId: string }
  | {
      action: "preview_rollback";
      sourceApprovalId: string;
      idempotencyKey: string;
    };

function readMutation(value: unknown): ProductActionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Product action request must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  if (row.action === "preview") {
    assertOnlyKeys(row, ["action", "expectedDraftVersion", "idempotencyKey"]);
    if (
      !Number.isInteger(row.expectedDraftVersion) ||
      Number(row.expectedDraftVersion) < 1
    ) {
      throw new SyntaxError("Save the private draft before reviewing it.");
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
  if (row.action === "preview_rollback") {
    assertOnlyKeys(row, ["action", "sourceApprovalId", "idempotencyKey"]);
    return {
      action: "preview_rollback",
      sourceApprovalId: readUuid(row.sourceApprovalId, "sourceApprovalId"),
      idempotencyKey: readUuid(row.idempotencyKey, "idempotencyKey"),
    };
  }
  throw new SyntaxError("Choose a product action to review or approve.");
}

function assertOnlyKeys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Product action request contains unexpected fields.");
  }
}

function readUuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyntaxError(`${field} must be a UUID.`);
  }
  return value;
}
