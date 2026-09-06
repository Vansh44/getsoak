import { describe, it, expect } from "vitest";
import {
  nextWatchTime,
  inWatchQuietHours,
  readWatchSchedule,
  watchFingerprint,
  type WatchSchedule,
} from "./watch-policy";
import type { BusinessBriefResult } from "./business-brief-types";

const schedule: WatchSchedule = {
  frequency: "daily",
  time: "09:00",
  weekday: 1,
  quietStart: "22:00",
  quietEnd: "08:00",
};
describe("watch schedules", () => {
  it("chooses the next Kolkata wall-clock minute", () => {
    expect(
      nextWatchTime(schedule, "Asia/Kolkata", new Date("2026-09-05T03:29:00Z")),
    ).toBe("2026-09-05T03:30:00.000Z");
    expect(
      nextWatchTime(schedule, "Asia/Kolkata", new Date("2026-09-05T03:30:00Z")),
    ).toBe("2026-09-06T03:30:00.000Z");
  });
  it("skips missed periods instead of catching up", () => {
    expect(
      nextWatchTime(
        { ...schedule, frequency: "weekly" },
        "Asia/Kolkata",
        new Date("2026-09-08T12:00:00Z"),
        "2026-08-31T03:30:00Z",
      ),
    ).toBe("2026-09-14T03:30:00.000Z");
  });
  it("skips a missing spring DST time", () => {
    expect(
      nextWatchTime(
        { ...schedule, time: "02:30" },
        "America/New_York",
        new Date("2026-03-08T05:00:00Z"),
      ),
    ).toBe("2026-03-09T06:30:00.000Z");
  });
  it("does not run twice on a fall-back day", () => {
    expect(
      nextWatchTime(
        { ...schedule, time: "01:30" },
        "America/New_York",
        new Date("2026-11-01T05:31:00Z"),
        "2026-11-01T05:30:00Z",
      ),
    ).toBe("2026-11-02T06:30:00.000Z");
  });
  it.each([
    null,
    [],
    {},
    { ...schedule, time: "24:00" },
    { ...schedule, weekday: 7 },
    { ...schedule, quietEnd: "22:00" },
    { ...schedule, quietEnd: null },
    { ...schedule, frequency: "hourly" },
    { ...schedule, storeId: "other" },
  ])("rejects invalid schedule %j", (value) =>
    expect(() => readWatchSchedule(value)).toThrow(),
  );
  it("accepts disabled quiet hours", () =>
    expect(
      readWatchSchedule({ ...schedule, quietStart: null, quietEnd: null })
        .quietStart,
    ).toBeNull());
  it.each([
    ["2026-09-05T16:30:00Z", true],
    ["2026-09-05T20:00:00Z", true],
    ["2026-09-06T02:30:00Z", false],
    ["2026-09-05T12:00:00Z", false],
  ])("overnight quiet hours at %s", (at, expected) =>
    expect(inWatchQuietHours(schedule, "Asia/Kolkata", new Date(at))).toBe(
      expected,
    ),
  );
  it("supports daytime quiet hours", () =>
    expect(
      inWatchQuietHours(
        { ...schedule, quietStart: "09:00", quietEnd: "17:00" },
        "UTC",
        new Date("2026-09-05T12:00:00Z"),
      ),
    ).toBe(true));
});
describe("watch deduplication", () => {
  const result = {
    rulesVersion: "business-brief-v1",
    fromInclusive: "from",
    toExclusive: "to",
    signals: [
      { key: "inventory", status: "attention" },
      { key: "sales", status: "attention" },
    ],
    locations: [
      { id: "shop", lowStock: 1, outOfStock: 2 },
      { id: "delhi", lowStock: 0, outOfStock: 4 },
    ],
  } as BusinessBriefResult;
  it("ignores result time and row order", () =>
    expect(watchFingerprint("inventory", result)).toBe(
      watchFingerprint("inventory", {
        ...result,
        dataAsOf: "later",
        locations: [...result.locations].reverse(),
      }),
    ));
  it("sees location changes even with identical store totals", () =>
    expect(watchFingerprint("inventory", result)).not.toBe(
      watchFingerprint("inventory", {
        ...result,
        locations: [
          {
            id: "shop",
            name: "Shop",
            trackedItems: 8,
            lowStock: 1,
            outOfStock: 4,
          },
          {
            id: "delhi",
            name: "Delhi",
            trackedItems: 8,
            lowStock: 0,
            outOfStock: 2,
          },
        ],
      }),
    ));
  it("keeps the same sales episode quiet", () =>
    expect(watchFingerprint("sales", result)).toBe(
      watchFingerprint("sales", { ...result, netSales: 12 }),
    ));
  it("does not call a healthy or unknown result attention", () =>
    expect(watchFingerprint("payments", result)).toBeNull());
  it("briefs use reporting period rather than noisy current time", () =>
    expect(watchFingerprint("brief", result)).toBe("from:to"));
});
