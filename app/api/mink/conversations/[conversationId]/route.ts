import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import {
  deleteMinkConversation,
  getMinkConversation,
  listMinkConversations,
} from "@/lib/mink/persistence";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const { conversationId } = await params;
  if (!UUID_PATTERN.test(conversationId)) {
    return NextResponse.json(
      { error: "Invalid Mink AI conversation." },
      { status: 400 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-history:${actor.storeId}:${actor.adminId}`,
      { max: 60, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI history is receiving too many requests." },
        { status: 429 },
      );
    }
    const conversation = await getMinkConversation(actor, conversationId);
    return NextResponse.json(
      { conversation },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.history: conversation rejected", {
        requestId,
        conversationId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.history: conversation failed", error, {
      requestId,
      conversationId,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't load that conversation." },
      { status: 503 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;

  const { conversationId } = await params;
  if (!UUID_PATTERN.test(conversationId)) {
    return NextResponse.json(
      { error: "Invalid Mink AI conversation." },
      { status: 400 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-history-write:${actor.storeId}:${actor.adminId}`,
      { max: 20, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI history is receiving too many requests." },
        { status: 429 },
      );
    }
    await deleteMinkConversation(actor, conversationId);
    const conversations = await listMinkConversations(actor);
    return NextResponse.json(
      { conversations },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.history: deletion rejected", {
        requestId,
        conversationId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.history: deletion failed", error, {
      requestId,
      conversationId,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't delete that conversation." },
      { status: 503 },
    );
  }
}
