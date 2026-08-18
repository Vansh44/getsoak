import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYTICS_TIME_ZONE,
  normalizeAnalyticsTimeZone,
  parseAnalyticsRange,
} from "./range";

describe("analytics ranges", () => {
  const now = new Date("2026-08-18T10:30:00.000Z");

  it("defaults invalid input to 90 days and the previous period", () => {
    const result = parseAnalyticsRange(
      { range: "forever", compare: "banana" },
      "invalid/zone",
      now,
    );
    expect(result.preset).toBe("90d");
    expect(result.comparison).toBe("previous");
    expect(result.timeZone).toBe(DEFAULT_ANALYTICS_TIME_ZONE);
    expect(result.current.from.toISOString()).toBe("2026-05-20T18:30:00.000Z");
    expect(result.current.to).toEqual(now);
  });

  it("uses half-open local-day bounds in Asia/Kolkata", () => {
    const result = parseAnalyticsRange(
      { range: "yesterday", compare: "none" },
      "Asia/Kolkata",
      now,
    );
    expect(result.current.from.toISOString()).toBe("2026-08-16T18:30:00.000Z");
    expect(result.current.to.toISOString()).toBe("2026-08-17T18:30:00.000Z");
    expect(result.compare).toBeNull();
  });

  it("accepts inclusive custom dates and rejects an inverted range", () => {
    const custom = parseAnalyticsRange(
      { range: "custom", from: "2026-08-01", to: "2026-08-03" },
      "Asia/Kolkata",
      now,
    );
    expect(custom.current.from.toISOString()).toBe("2026-07-31T18:30:00.000Z");
    expect(custom.current.to.toISOString()).toBe("2026-08-03T18:30:00.000Z");

    const fallback = parseAnalyticsRange(
      { range: "custom", from: "2026-08-03", to: "2026-08-01" },
      "Asia/Kolkata",
      now,
    );
    expect(fallback.preset).toBe("90d");
  });

  it("does not assume a 24-hour day across a DST transition", () => {
    const result = parseAnalyticsRange(
      {
        range: "custom",
        from: "2026-03-08",
        to: "2026-03-08",
        compare: "none",
      },
      "America/New_York",
      now,
    );
    expect(result.current.from.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(result.current.to.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(result.current.to.getTime() - result.current.from.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
  });

  it("validates IANA zones", () => {
    expect(normalizeAnalyticsTimeZone("Europe/London")).toBe("Europe/London");
    expect(normalizeAnalyticsTimeZone("GMT+5")).toBe(
      DEFAULT_ANALYTICS_TIME_ZONE,
    );
  });
});
