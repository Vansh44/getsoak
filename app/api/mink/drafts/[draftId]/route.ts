import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import {
  getMinkDraft,
  rollbackMinkDraftVersion,
  saveMinkDraftVersion,
} from "@/lib/mink/drafts";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32_768;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  return handleDraftRequest("read", await params, async (actor, draftId) =>
    getMinkDraft(actor, draftId),
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Draft request is too large." },
      { status: 413 },
    );
  }
  let body: DraftMutation;
  try {
    body = readMutation(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid draft request.",
      },
      { status: 400 },
    );
  }
  return handleDraftRequest("write", await params, async (actor, draftId) =>
    body.action === "save"
      ? saveMinkDraftVersion({
          actor,
          draftId,
          expectedVersion: body.expectedVersion,
          content: body.content,
        })
      : rollbackMinkDraftVersion({
          actor,
          draftId,
          expectedVersion: body.expectedVersion,
          targetVersion: body.targetVersion,
        }),
  );
}

async function handleDraftRequest(
  operation: "read" | "write",
  params: { draftId: string },
  handler: (
    actor: Awaited<ReturnType<typeof getMinkActorContext>>,
    draftId: string,
  ) => Promise<unknown>,
) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }
  if (!UUID_PATTERN.test(params.draftId)) {
    return NextResponse.json(
      { error: "Invalid Mink AI draft." },
      { status: 400 },
    );
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-draft-${operation}:${actor.storeId}:${actor.adminId}`,
      { max: operation === "read" ? 60 : 20, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI drafts are receiving too many requests." },
        { status: 429 },
      );
    }
    const draft = await handler(actor, params.draftId);
    return NextResponse.json(
      { draft },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.draft: request rejected", {
        requestId,
        draftId: params.draftId,
        operation,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.draft: request failed", error, {
      requestId,
      draftId: params.draftId,
      operation,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't update that private draft." },
      { status: 503 },
    );
  }
}

type DraftMutation =
  | { action: "save"; expectedVersion: number; content: unknown }
  | { action: "rollback"; expectedVersion: number; targetVersion: number };

function readMutation(value: unknown): DraftMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Draft request must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  if (
    !Number.isInteger(row.expectedVersion) ||
    Number(row.expectedVersion) < 0
  ) {
    throw new SyntaxError("expectedVersion must be a non-negative integer.");
  }
  if (row.action === "save") {
    return {
      action: "save",
      expectedVersion: Number(row.expectedVersion),
      content: row.content,
    };
  }
  if (
    row.action === "rollback" &&
    Number.isInteger(row.targetVersion) &&
    Number(row.targetVersion) > 0
  ) {
    return {
      action: "rollback",
      expectedVersion: Number(row.expectedVersion),
      targetVersion: Number(row.targetVersion),
    };
  }
  throw new SyntaxError("Choose save or a valid version to restore.");
}
