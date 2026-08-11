import { describe, expect, it } from "vitest";
import {
  DEFAULT_POS_DATE_RANGE,
  POS_DATE_RANGES,
  isPosDateRangeKey,
  posDateRange,
  type PosDateRangeKey,
} from "./date-range";

// The suite runs under TZ=UTC (vitest.config.ts), which is the point: production
// runs in UTC on Cloud Run, and the bug this guards against is a shop day
// computed in the SERVER's zone rather than the shop's.

/** 1:00 am IST on 12 Aug 2026 — i.e. 19:30 UTC on 11 Aug. The window where a
 *  naive server-side `new Date()` puts the sale in the wrong day. */
const LATE_NIGHT_IST = new Date("2026-08-11T19:30:00.000Z");
/** 3:00 pm IST on 12 Aug 2026, safely mid-day in both zones. */
const MIDDAY_IST = new Date("2026-08-12T09:30:00.000Z");

/** IST midnight for a given date renders as 18:30 UTC the day before. */
const istMidnight = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00.000+05:30`).toISOString();

describe("POS date ranges", () => {
  it("has a unique key per option, and a valid default", () => {
    const keys = POS_DATE_RANGES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(isPosDateRangeKey(DEFAULT_POS_DATE_RANGE)).toBe(true);
  });

  it("rejects anything not in the registry", () => {
    expect(isPosDateRangeKey("week")).toBe(false);
    expect(isPosDateRangeKey("")).toBe(false);
    expect(isPosDateRangeKey(undefined)).toBe(false);
    // The validation the action leans on — a key off the wire must not become
    // a window nobody intended.
    expect(isPosDateRangeKey({ key: "today" })).toBe(false);
  });

  describe("★ the day is the SHOP's, not the server's", () => {
    it("puts 1 am IST in TODAY, not yesterday", () => {
      // The regression that matters. At 19:30 UTC the server's calendar date is
      // 11 Aug while the shop's is 12 Aug; computing the window in UTC would
      // exclude every sale from the first 5.5 hours of the shop's day.
      const r = posDateRange("today", LATE_NIGHT_IST)!;
      expect(r.from.toISOString()).toBe(istMidnight("2026-08-12"));
      expect(r.to.toISOString()).toBe(istMidnight("2026-08-13"));
      expect(LATE_NIGHT_IST >= r.from).toBe(true);
      expect(LATE_NIGHT_IST < r.to).toBe(true);
    });

    it("agrees at midday, when the two zones share a date", () => {
      const r = posDateRange("today", MIDDAY_IST)!;
      expect(r.from.toISOString()).toBe(istMidnight("2026-08-12"));
      expect(MIDDAY_IST >= r.from && MIDDAY_IST < r.to).toBe(true);
    });
  });

  describe("the windows tile without gaps or overlap", () => {
    it("ends yesterday exactly where today begins", () => {
      // A sale must land in exactly one of them — never both, never neither.
      const today = posDateRange("today", MIDDAY_IST)!;
      const yday = posDateRange("yesterday", MIDDAY_IST)!;
      expect(yday.to.getTime()).toBe(today.from.getTime());
      expect(yday.from.toISOString()).toBe(istMidnight("2026-08-11"));
    });

    it("counts today IN the rolling windows, so 7 days is 7 shop-days", () => {
      const r7 = posDateRange("7d", MIDDAY_IST)!;
      expect(r7.from.toISOString()).toBe(istMidnight("2026-08-06"));
      const r30 = posDateRange("30d", MIDDAY_IST)!;
      expect(r30.from.toISOString()).toBe(istMidnight("2026-07-14"));
      // Both end at tomorrow's midnight, so a sale rung mid-request is included.
      expect(r7.to.toISOString()).toBe(istMidnight("2026-08-13"));
      expect(r30.to.toISOString()).toBe(istMidnight("2026-08-13"));
    });

    it("ends at tomorrow's midnight, not at `now`", () => {
      // If `to` were `now`, a sale completing while the list rendered would fall
      // outside the window it belongs to.
      const r = posDateRange("today", MIDDAY_IST)!;
      expect(r.to.getTime()).toBeGreaterThan(MIDDAY_IST.getTime());
    });
  });

  describe("boundaries", () => {
    it("crosses a month end", () => {
      // 1 Sep 2026, 00:30 IST. Date.UTC normalises the negative day-of-month.
      const sept1 = new Date("2026-08-31T19:00:00.000Z");
      expect(posDateRange("yesterday", sept1)!.from.toISOString()).toBe(
        istMidnight("2026-08-31"),
      );
      expect(posDateRange("7d", sept1)!.from.toISOString()).toBe(
        istMidnight("2026-08-26"),
      );
    });

    it("crosses a year end", () => {
      const jan1 = new Date("2026-12-31T19:00:00.000Z"); // 1 Jan 2027, 00:30 IST
      expect(posDateRange("today", jan1)!.from.toISOString()).toBe(
        istMidnight("2027-01-01"),
      );
      expect(posDateRange("yesterday", jan1)!.from.toISOString()).toBe(
        istMidnight("2026-12-31"),
      );
    });

    it("handles a leap day", () => {
      const mar1 = new Date("2028-02-29T19:00:00.000Z"); // 1 Mar 2028, 00:30 IST
      expect(posDateRange("yesterday", mar1)!.from.toISOString()).toBe(
        istMidnight("2028-02-29"),
      );
    });
  });

  it("returns null for `all` — no predicate, NOT an empty window", () => {
    // A range object covering everything would still add a WHERE clause; null
    // is how the action knows to add none.
    expect(posDateRange("all", MIDDAY_IST)).toBeNull();
  });

  it("gives every registered key a window (or a deliberate null)", () => {
    for (const { key } of POS_DATE_RANGES) {
      const r = posDateRange(key as PosDateRangeKey, MIDDAY_IST);
      if (key === "all") {
        expect(r).toBeNull();
        continue;
      }
      expect(r).not.toBeNull();
      expect(r!.from.getTime()).toBeLessThan(r!.to.getTime());
    }
  });
});
