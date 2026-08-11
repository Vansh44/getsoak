// Date ranges for the till's Sales list.
//
// ★ THE RANGE IS COMPUTED SERVER-SIDE FROM A KEY, NOT SENT AS TIMESTAMPS.
// The client could compute "today" from its own clock, but then the boundary
// depends on a device someone may have set wrong, and a till that disagrees with
// the shift report about which day a sale belongs to is worse than no filter.
// The client sends `today`; the server decides what that means.
//
// ★★ AND IT MEANS THE SHOP'S DAY, NOT THE SERVER'S. Production runs on Cloud
// Run in UTC. A sale rung at 1:00 am IST is 19:30 UTC on the PREVIOUS date, so
// a naive `new Date()` server-side puts the first five and a half hours of every
// shop's day into yesterday's "Today" — every night, silently. This is the same
// pin lib/notifications/format.ts already applies to dates in email (§24), for
// the same reason.
//
// A FIXED +05:30 offset is exact here only because **India does not observe
// DST**. When per-store timezones arrive this must become a real zone lookup —
// a fixed offset for a DST zone is wrong for half the year.

/** Asia/Kolkata is UTC+05:30 year-round. */
const IST_OFFSET_MS = 330 * 60 * 1000;

export type PosDateRangeKey = "today" | "yesterday" | "7d" | "30d" | "all";

export interface PosDateRangeOption {
  key: PosDateRangeKey;
  /** The chip. */
  label: string;
  /**
   * The same range as a sentence fragment, for "No sales ___."
   *
   * A separate field rather than a lowercased label, because the two are not
   * the same string: "Last 7 days" lowercased gives "No sales last 7 days",
   * which is not English. `all` has none — there is no range to name.
   */
  phrase: string;
}

/** Display order. `today` first — reconciling a shift or finding the bill from
 *  ten minutes ago is what this list is opened for. */
export const POS_DATE_RANGES: readonly PosDateRangeOption[] = [
  { key: "today", label: "Today", phrase: "today" },
  { key: "yesterday", label: "Yesterday", phrase: "yesterday" },
  { key: "7d", label: "Last 7 days", phrase: "in the last 7 days" },
  { key: "30d", label: "Last 30 days", phrase: "in the last 30 days" },
  { key: "all", label: "All", phrase: "" },
] as const;

/** The sentence fragment for a range, or "" for `all`. */
export function posDateRangePhrase(key: PosDateRangeKey): string {
  return POS_DATE_RANGES.find((r) => r.key === key)?.phrase ?? "";
}

export const DEFAULT_POS_DATE_RANGE: PosDateRangeKey = "all";

export function isPosDateRangeKey(v: unknown): v is PosDateRangeKey {
  return POS_DATE_RANGES.some((r) => r.key === v);
}

/**
 * Midnight in Asia/Kolkata, `daysAgo` days back, as an absolute instant.
 *
 * Shifting the instant by the offset makes its UTC fields read as the IST wall
 * clock, so the calendar date can be taken from them; rebuilding at midnight and
 * shifting back gives the instant that day started. Date.UTC normalises a
 * negative day-of-month, so month and year boundaries need no special case.
 */
function startOfShopDay(instant: Date, daysAgo = 0): Date {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  const midnightIst = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysAgo,
  );
  return new Date(midnightIst - IST_OFFSET_MS);
}

/**
 * The half-open window `[from, to)` for a range key, or null for "all" — null
 * means "add no date predicate", which is not the same as an empty window.
 *
 * `to` is the START of the next day rather than "now", so a sale rung during the
 * request cannot fall outside the window it belongs to; and `yesterday` ends
 * exactly where `today` begins, so no sale can land in both or neither.
 */
export function posDateRange(
  key: PosDateRangeKey,
  now: Date = new Date(),
): { from: Date; to: Date } | null {
  const startToday = startOfShopDay(now);
  const startTomorrow = startOfShopDay(now, -1);

  switch (key) {
    case "today":
      return { from: startToday, to: startTomorrow };
    case "yesterday":
      return { from: startOfShopDay(now, 1), to: startToday };
    // Inclusive of today, so "last 7 days" is 7 shop-days and not 8.
    case "7d":
      return { from: startOfShopDay(now, 6), to: startTomorrow };
    case "30d":
      return { from: startOfShopDay(now, 29), to: startTomorrow };
    case "all":
      return null;
  }
}
