import "server-only";

import { and, eq } from "drizzle-orm";
import { minkFeedback, minkRuns } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";
import type {
  MinkActorContext,
  MinkFeedbackIssue,
  MinkFeedbackRating,
} from "./types";

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)\+?(?:\d[\s-]?){9,14}\d(?!\d)/g;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SECRET = /\b(api[_ -]?key|password|secret|token|otp)\s*[:=]\s*\S+/gi;
const BEARER = /\bbearer\s+[a-z0-9._~+/=-]+/gi;

export function redactMinkFeedbackDetails(value: string): string | null {
  const cleaned = value
    .normalize("NFKC")
    .replace(EMAIL, "[email redacted]")
    .replace(UUID, "[identifier redacted]")
    .replace(PHONE, "[phone redacted]")
    .replace(SECRET, "$1: [redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return cleaned || null;
}

export async function saveMinkFeedback(input: {
  actor: MinkActorContext;
  runId: string;
  rating: MinkFeedbackRating;
  issueCategory: MinkFeedbackIssue | null;
  details: string;
}) {
  const detailsRedacted = redactMinkFeedbackDetails(input.details);
  const updatedAt = new Date().toISOString();
  return withService(async (db) => {
    const run = await db
      .select({ id: minkRuns.id })
      .from(minkRuns)
      .where(
        and(
          eq(minkRuns.id, input.runId),
          eq(minkRuns.storeId, input.actor.storeId),
          eq(minkRuns.requestedBy, input.actor.adminId),
        ),
      )
      .limit(1);
    if (!run[0]) {
      throw new MinkRequestError(
        "mink_run_not_found",
        "That Mink AI answer is no longer available for feedback.",
        404,
      );
    }
    const rows = await db
      .insert(minkFeedback)
      .values({
        storeId: input.actor.storeId,
        runId: input.runId,
        adminId: input.actor.adminId,
        rating: input.rating,
        issueCategory: input.issueCategory,
        detailsRedacted,
      })
      .onConflictDoUpdate({
        target: [minkFeedback.runId, minkFeedback.adminId],
        set: {
          rating: input.rating,
          issueCategory: input.issueCategory,
          detailsRedacted,
          updatedAt,
        },
      })
      .returning({
        rating: minkFeedback.rating,
        issueCategory: minkFeedback.issueCategory,
      });
    return rows[0];
  });
}
