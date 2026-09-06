import type { BusinessBriefResult } from "./business-brief-types";

export const WATCH_KINDS = [
  "brief",
  "inventory",
  "sales",
  "returns",
  "payments",
] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export interface WatchSchedule {
  frequency: "daily" | "weekly";
  time: string;
  weekday: number;
  quietStart: string | null;
  quietEnd: string | null;
}
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function readWatchSchedule(value: unknown): WatchSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a schedule.");
  const s = value as WatchSchedule;
  if (
    Object.keys(s).some(
      (k) =>
        !["frequency", "time", "weekday", "quietStart", "quietEnd"].includes(k),
    ) ||
    !["daily", "weekly"].includes(s.frequency) ||
    typeof s.time !== "string" ||
    !TIME.test(s.time) ||
    !Number.isInteger(s.weekday) ||
    s.weekday < 0 ||
    s.weekday > 6 ||
    !(
      (s.quietStart === null && s.quietEnd === null) ||
      (typeof s.quietStart === "string" &&
        typeof s.quietEnd === "string" &&
        TIME.test(s.quietStart) &&
        TIME.test(s.quietEnd) &&
        s.quietStart !== s.quietEnd)
    )
  )
    throw new Error(
      "Choose daily or weekly, a valid time and either two different quiet-hour times or no quiet hours.",
    );
  return {
    frequency: s.frequency,
    time: s.time,
    weekday: s.weekday,
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
  };
}
function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
function localParts(date: Date, f: Intl.DateTimeFormat) {
  const p = Object.fromEntries(
    f.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    weekday: new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay(),
  };
}
/** Bounded minute search handles half-hour zones and DST gaps without guessing an offset.
 * A missing local time skips that occurrence. skipDate prevents a fall-back duplicate. */
export function nextWatchTime(
  schedule: WatchSchedule,
  zone: string,
  after: Date,
  previousSlot?: string,
): string {
  const f = formatter(zone);
  const skipDate = previousSlot
    ? localParts(new Date(previousSlot), f).date
    : null;
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 16 * 24 * 60; minute++) {
    const instant = new Date(start + minute * 60_000);
    const p = localParts(instant, f);
    if (
      p.date !== skipDate &&
      p.time === schedule.time &&
      (schedule.frequency === "daily" || p.weekday === schedule.weekday)
    )
      return instant.toISOString();
  }
  throw new Error("No scheduled time found in the next 16 days.");
}
export function inWatchQuietHours(
  schedule: WatchSchedule,
  zone: string,
  now: Date,
): boolean {
  if (!schedule.quietStart || !schedule.quietEnd) return false;
  const { time } = localParts(now, formatter(zone));
  return schedule.quietStart < schedule.quietEnd
    ? time >= schedule.quietStart && time < schedule.quietEnd
    : time >= schedule.quietStart || time < schedule.quietEnd;
}
/** Compare attention state, not timestamps or prose. Unchanged conditions stay quiet.
 * Inventory is location-level aggregate evidence, not an individual-SKU change feed. */
export function watchFingerprint(
  kind: WatchKind,
  result: BusinessBriefResult,
): string | null {
  if (kind === "brief") return `${result.fromInclusive}:${result.toExclusive}`;
  if (result.signals.find((s) => s.key === kind)?.status !== "attention")
    return null;
  if (kind === "inventory")
    return JSON.stringify(
      result.locations
        .map((l) => [l.id, l.lowStock, l.outOfStock])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  // Re-alert only on recovery followed by a new episode, not small daily metric movements.
  return `${result.rulesVersion}:${kind}:attention`;
}
