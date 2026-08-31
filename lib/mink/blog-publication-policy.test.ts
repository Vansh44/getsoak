import { describe, expect, it } from "vitest";
import {
  MAX_MINK_BLOG_SCHEDULE_AHEAD_MS,
  MIN_MINK_BLOG_SCHEDULE_LEAD_MS,
  MinkBlogPublicationTimingError,
  normalizeMinkBlogPublicationTiming,
} from "./blog-publication-policy";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");

describe("Mink blog publication timing", () => {
  it("normalizes an immediate publication without a date", () => {
    expect(
      normalizeMinkBlogPublicationTiming({ mode: "publish_now", nowMs: NOW }),
    ).toEqual({ mode: "publish_now", scheduledFor: null });
  });

  it("accepts a canonical instant inside the safe scheduling window", () => {
    expect(
      normalizeMinkBlogPublicationTiming({
        mode: "schedule",
        scheduledFor: "2026-09-01T00:10:00Z",
        nowMs: NOW,
      }),
    ).toEqual({
      mode: "schedule",
      scheduledFor: "2026-09-01T00:10:00.000Z",
    });
  });

  it.each([
    ["2026-09-01T05:40", "timezone-aware"],
    [
      new Date(NOW + MIN_MINK_BLOG_SCHEDULE_LEAD_MS - 1).toISOString(),
      "at least 5 minutes",
    ],
    [
      new Date(NOW + MAX_MINK_BLOG_SCHEDULE_AHEAD_MS + 1).toISOString(),
      "no more than 90 days",
    ],
  ])("rejects unsafe schedule %s", (scheduledFor, message) => {
    expect(() =>
      normalizeMinkBlogPublicationTiming({
        mode: "schedule",
        scheduledFor,
        nowMs: NOW,
      }),
    ).toThrow(message);
  });

  it("rejects extra timing data for an immediate publication", () => {
    expect(() =>
      normalizeMinkBlogPublicationTiming({
        mode: "publish_now",
        scheduledFor: "2026-09-01T01:00:00.000Z",
        nowMs: NOW,
      }),
    ).toThrow(MinkBlogPublicationTimingError);
  });
});
