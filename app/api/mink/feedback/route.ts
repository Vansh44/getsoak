import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { saveMinkFeedback } from "@/lib/mink/feedback";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import type { MinkFeedbackIssue, MinkFeedbackRating } from "@/lib/mink/types";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUES = new Set<MinkFeedbackIssue>([
  "incorrect",
  "missing_context",
  "privacy",
  "slow",
  "other",
]);

export async function POST(request: Request) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const requestId = crypto.randomUUID();
  try {
    const body = readFeedback(await request.json());
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-feedback:${actor.storeId}:${actor.adminId}`,
      { max: 30, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI feedback is receiving too many requests." },
        { status: 429 },
      );
    }
    const feedback = await saveMinkFeedback({ actor, ...body });
    return NextResponse.json(
      { feedback },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.feedback: request rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logError("mink.feedback: failed", error, { requestId });
    return NextResponse.json(
      { error: "Mink AI couldn't save that feedback." },
      { status: 503 },
    );
  }
}

function readFeedback(value: unknown): {
  runId: string;
  rating: MinkFeedbackRating;
  issueCategory: MinkFeedbackIssue | null;
  details: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Feedback must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.runId !== "string" || !UUID_PATTERN.test(row.runId)) {
    throw new SyntaxError("runId must be a UUID.");
  }
  if (row.rating !== "helpful" && row.rating !== "unhelpful") {
    throw new SyntaxError("rating must be helpful or unhelpful.");
  }
  const issueCategory =
    typeof row.issueCategory === "string" &&
    ISSUES.has(row.issueCategory as MinkFeedbackIssue)
      ? (row.issueCategory as MinkFeedbackIssue)
      : null;
  if (row.rating === "unhelpful" && !issueCategory) {
    throw new SyntaxError("Choose why the answer was unhelpful.");
  }
  const details = row.details === undefined ? "" : row.details;
  if (typeof details !== "string" || details.length > 1_000) {
    throw new SyntaxError("details must be at most 1000 characters.");
  }
  return { runId: row.runId, rating: row.rating, issueCategory, details };
}
