import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import {
  cancelMinkWorkflow,
  getMinkWorkflow,
  resumeMinkWorkflow,
} from "@/lib/mink/workflows";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_024;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  return handle("read", await params, async (actor, workflowId) =>
    getMinkWorkflow(actor, workflowId),
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workflowId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Workflow request is too large." },
      { status: 413 },
    );
  }
  let action: "cancel" | "resume";
  try {
    action = readAction(await readBoundedJson(request));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid workflow request.",
      },
      { status: error instanceof BodyTooLargeError ? 413 : 400 },
    );
  }
  return handle(action, await params, async (actor, workflowId) =>
    action === "cancel"
      ? cancelMinkWorkflow(actor, workflowId)
      : resumeMinkWorkflow(actor, workflowId),
  );
}

async function handle(
  operation: "read" | "cancel" | "resume",
  params: { workflowId: string },
  callback: (
    actor: Awaited<ReturnType<typeof getMinkActorContext>>,
    workflowId: string,
  ) => Promise<unknown>,
) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }
  if (!UUID_PATTERN.test(params.workflowId)) {
    return NextResponse.json(
      { error: "Invalid Mink workflow." },
      { status: 400 },
    );
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-workflow-${operation}:${actor.storeId}:${actor.adminId}`,
      { max: operation === "read" ? 120 : 10, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink workflows are receiving too many requests." },
        { status: 429 },
      );
    }
    const workflow = await callback(actor, params.workflowId);
    return NextResponse.json(
      { workflow },
      {
        headers: {
          "Cache-Control": "no-store, private",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.workflow: request rejected", {
        requestId,
        workflowId: params.workflowId,
        operation,
        code: error.code,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.workflow: request failed", error, {
      requestId,
      workflowId: params.workflowId,
      operation,
    });
    return NextResponse.json(
      { error: "Mink couldn't load that workflow." },
      { status: 503 },
    );
  }
}

function readAction(value: unknown): "cancel" | "resume" {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Workflow request must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  // ★★ THE TYPE IS CHECKED BEFORE THE ALLOWLIST, and the value returned is the
  // one that was checked. This read `String(row.action)`, so `["cancel"]`
  // stringifies to `"cancel"` and PASSED — and then the raw ARRAY was returned
  // (the `as` cast hid it), so the dispatcher's `action === "cancel"` was false
  // because an array is not a string, and the request fell through to RESUME.
  // A body whose only stated intent was to cancel resumed a run instead. The
  // strict-key check catches an extra key; it cannot catch a wrong-typed value.
  const action = row.action;
  if (
    Object.keys(row).length !== 1 ||
    typeof action !== "string" ||
    !["cancel", "resume"].includes(action)
  ) {
    throw new SyntaxError("Choose cancel or resume.");
  }
  return action as "cancel" | "resume";
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Workflow request is empty.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
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
