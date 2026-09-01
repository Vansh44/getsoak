export const MINK_BLOG_PUBLICATION_MODES = ["publish_now", "schedule"] as const;

export type MinkBlogPublicationMode =
  (typeof MINK_BLOG_PUBLICATION_MODES)[number];

export const MIN_MINK_BLOG_SCHEDULE_LEAD_MS = 5 * 60 * 1_000;
export const MAX_MINK_BLOG_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1_000;

export type MinkBlogPublicationTiming =
  | { mode: "publish_now"; scheduledFor: null }
  | { mode: "schedule"; scheduledFor: string };

export class MinkBlogPublicationTimingError extends Error {}

/**
 * Normalize the browser's publication choice at the server boundary.
 *
 * Dates are accepted only as canonical, timezone-bearing ISO instants. This
 * prevents a Cloud Run UTC process and an admin's local browser from silently
 * approving different wall-clock times.
 */
export function normalizeMinkBlogPublicationTiming(input: {
  mode: unknown;
  scheduledFor?: unknown;
  nowMs?: number;
}): MinkBlogPublicationTiming {
  if (!MINK_BLOG_PUBLICATION_MODES.includes(input.mode as never)) {
    throw new MinkBlogPublicationTimingError(
      "Choose Publish now or Schedule for later.",
    );
  }
  if (input.mode === "publish_now") {
    if (input.scheduledFor !== undefined && input.scheduledFor !== null) {
      throw new MinkBlogPublicationTimingError(
        "Publish now cannot include a scheduled time.",
      );
    }
    return { mode: "publish_now", scheduledFor: null };
  }
  if (typeof input.scheduledFor !== "string") {
    throw new MinkBlogPublicationTimingError(
      "Choose a date and time for the scheduled publication.",
    );
  }
  const value = input.scheduledFor.trim();
  if (
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value)
  ) {
    throw new MinkBlogPublicationTimingError(
      "The scheduled time must be a timezone-aware UTC instant.",
    );
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new MinkBlogPublicationTimingError(
      "The scheduled publication time is invalid.",
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  if (instant < nowMs + MIN_MINK_BLOG_SCHEDULE_LEAD_MS) {
    throw new MinkBlogPublicationTimingError(
      "Schedule the blog at least 5 minutes from now.",
    );
  }
  if (instant > nowMs + MAX_MINK_BLOG_SCHEDULE_AHEAD_MS) {
    throw new MinkBlogPublicationTimingError(
      "Schedule the blog no more than 90 days ahead.",
    );
  }
  return { mode: "schedule", scheduledFor: new Date(instant).toISOString() };
}
