import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import {
  executeMinkDomainAction,
  previewMinkDomainAction,
  previewMinkDomainActionRollback,
} from "@/lib/mink/domain-actions";
import { MinkRequestError } from "@/lib/mink/errors";
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
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Mink action request is too large." },
      { status: 413 },
    );
  }
  let mutation: ActionMutation;
  try {
    mutation = readMutation(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Invalid Mink action request.",
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
      `mink-domain-action:${actor.storeId}:${actor.adminId}`,
      { max: 12, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink actions are receiving too many requests." },
        { status: 429 },
      );
    }

    if (mutation.action === "preview") {
      const approval = await previewMinkDomainAction({
        actor,
        draftId,
        expectedDraftVersion: mutation.expectedDraftVersion,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }
    if (mutation.action === "preview_rollback") {
      const approval = await previewMinkDomainActionRollback({
        actor,
        draftId,
        sourceApprovalId: mutation.sourceApprovalId,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }
    const result = await executeMinkDomainAction({
      actor,
      draftId,
      approvalId: mutation.approvalId,
    });
    invalidate(result.approval.resource.type, result.approval.resource.id);
    if (!result.repeated) emitStandardEvent(actor, result.approval);
    return privateJson({ result });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.domain_action: request rejected", {
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
    logError("mink.domain_action: request failed", error, {
      requestId,
      draftId,
      action: mutation.action,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't complete that action." },
      { status: 503 },
    );
  }
}

function privateJson(value: unknown) {
  return NextResponse.json(value, {
    headers: { "Cache-Control": "no-store, private" },
  });
}

function invalidate(
  type: "product" | "coupon" | "customer_group",
  id: string | null,
) {
  if (type === "product") {
    revalidatePath("/dashboard/products");
    if (id) revalidatePath(`/dashboard/products/${id}`);
    revalidateTag(TAGS.products, "max");
  } else if (type === "coupon") {
    revalidatePath("/dashboard/marketing/coupons");
    if (id) revalidatePath(`/dashboard/marketing/coupons/${id}/edit`);
    revalidateTag(TAGS.coupons, "max");
  } else {
    revalidatePath("/dashboard/users/user_groups");
    if (id) revalidatePath(`/dashboard/users/user_groups/${id}/edit`);
  }
}

function emitStandardEvent(
  actor: Awaited<ReturnType<typeof getMinkActorContext>>,
  approval: Awaited<ReturnType<typeof executeMinkDomainAction>>["approval"],
) {
  const id = approval.resource.id;
  if (!id) return;
  const common = {
    storeId: actor.storeId,
    actor: { type: "admin" as const, id: actor.adminId, label: actor.email },
    payload: {
      source: "mink_ai",
      tool: approval.toolName,
      approvalId: approval.id,
    },
  };
  if (
    approval.toolName === "create_product" &&
    approval.operation === "rollback"
  ) {
    emitEvent({
      ...common,
      type: "product.deleted",
      subject: { type: "product", id, label: approval.resource.label },
    });
    return;
  }
  if (approval.operation !== "apply") return;
  if (approval.toolName === "create_product") {
    emitEvent({
      ...common,
      type: "product.created",
      subject: { type: "product", id, label: approval.resource.label },
    });
  } else if (approval.toolName === "create_coupon") {
    emitEvent({
      ...common,
      type: "coupon.created",
      subject: { type: "coupon", id, label: approval.resource.label },
    });
  }
}

type ActionMutation =
  | { action: "preview"; expectedDraftVersion: number; idempotencyKey: string }
  | { action: "execute"; approvalId: string }
  | {
      action: "preview_rollback";
      sourceApprovalId: string;
      idempotencyKey: string;
    };

function readMutation(value: unknown): ActionMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Mink action request must be a JSON object.");
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
  if (row.action === "preview_rollback") {
    assertOnlyKeys(row, ["action", "sourceApprovalId", "idempotencyKey"]);
    return {
      action: "preview_rollback",
      sourceApprovalId: readUuid(row.sourceApprovalId, "sourceApprovalId"),
      idempotencyKey: readUuid(row.idempotencyKey, "idempotencyKey"),
    };
  }
  throw new SyntaxError("Unknown Mink action request.");
}

function readUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyntaxError(`${label} must be a UUID.`);
  }
  return value;
}

function assertOnlyKeys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Mink action request has unsupported fields.");
  }
}
