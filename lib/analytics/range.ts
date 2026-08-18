export const DEFAULT_ANALYTICS_TIME_ZONE = "Asia/Kolkata";

/** Common merchant zones for the first settings control; validation accepts any IANA zone. */
export const COMMON_ANALYTICS_TIME_ZONES = [
  ["Asia/Kolkata", "India — Kolkata"],
  ["Asia/Dubai", "United Arab Emirates — Dubai"],
  ["Asia/Singapore", "Singapore"],
  ["Europe/London", "United Kingdom — London"],
  ["America/New_York", "United States — Eastern"],
  ["America/Chicago", "United States — Central"],
  ["America/Denver", "United States — Mountain"],
  ["America/Los_Angeles", "United States — Pacific"],
  ["Australia/Sydney", "Australia — Sydney"],
] as const;

export const ANALYTICS_RANGE_PRESETS = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "90d",
  "mtd",
  "ytd",
  "12m",
  "custom",
] as const;

export const ANALYTICS_COMPARISONS = [
  "previous",
  "year",
  "custom",
  "none",
] as const;

export type AnalyticsRangePreset = (typeof ANALYTICS_RANGE_PRESETS)[number];
export type AnalyticsComparison = (typeof ANALYTICS_COMPARISONS)[number];
export type AnalyticsSearchParams = Record<
  string,
  string | string[] | undefined
>;

export interface AnalyticsWindow {
  /** Inclusive instant. */
  from: Date;
  /** Exclusive instant. */
  to: Date;
}

export interface AnalyticsRange {
  preset: AnalyticsRangePreset;
  comparison: AnalyticsComparison;
  current: AnalyticsWindow;
  compare: AnalyticsWindow | null;
  timeZone: string;
  label: string;
  comparisonLabel: string | null;
  customFrom: string;
  customTo: string;
  compareFrom: string;
  compareTo: string;
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const RANGE_SET = new Set<string>(ANALYTICS_RANGE_PRESETS);
const COMPARISON_SET = new Set<string>(ANALYTICS_COMPARISONS);

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function normalizeAnalyticsTimeZone(value: unknown): string {
  return isValidTimeZone(value) ? value : DEFAULT_ANALYTICS_TIME_ZONE;
}

function partsAt(instant: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
    millisecond: instant.getUTCMilliseconds(),
  };
}

/** Convert a wall-clock value in an IANA zone to its absolute instant. */
function localToInstant(local: LocalDateTime, timeZone: string): Date {
  const wanted = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.millisecond,
  );
  let guess = wanted;
  // Re-evaluate the zone offset because it can change at a DST boundary.
  for (let i = 0; i < 4; i++) {
    const actual = partsAt(new Date(guess), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      actual.millisecond,
    );
    const next = guess + (wanted - represented);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function shiftLocal(
  local: LocalDateTime,
  change: { days?: number; months?: number; years?: number },
): LocalDateTime {
  const shifted = new Date(
    Date.UTC(
      local.year + (change.years ?? 0),
      local.month - 1 + (change.months ?? 0),
      local.day + (change.days ?? 0),
      local.hour,
      local.minute,
      local.second,
      local.millisecond,
    ),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function midnight(local: LocalDateTime): LocalDateTime {
  return { ...local, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

function parseDateKey(value: string | undefined): LocalDateTime | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

function dateKey(local: LocalDateTime): string {
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

function displayDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(instant);
}

function windowLabel(window: AnalyticsWindow, timeZone: string): string {
  const inclusiveEnd = new Date(window.to.getTime() - 1);
  const start = displayDate(window.from, timeZone);
  const end = displayDate(inclusiveEnd, timeZone);
  return start === end ? start : `${start} – ${end}`;
}

function customWindow(
  fromValue: string | undefined,
  toValue: string | undefined,
  timeZone: string,
): AnalyticsWindow | null {
  const from = parseDateKey(fromValue);
  const to = parseDateKey(toValue);
  if (!from || !to) return null;
  const start = localToInstant(from, timeZone);
  const end = localToInstant(shiftLocal(to, { days: 1 }), timeZone);
  return start < end ? { from: start, to: end } : null;
}

function presetWindow(
  preset: Exclude<AnalyticsRangePreset, "custom">,
  now: Date,
  timeZone: string,
): AnalyticsWindow {
  const localNow = partsAt(now, timeZone);
  let from: LocalDateTime;
  let to = now;

  switch (preset) {
    case "today":
      from = midnight(localNow);
      break;
    case "yesterday":
      from = shiftLocal(midnight(localNow), { days: -1 });
      to = localToInstant(midnight(localNow), timeZone);
      break;
    case "7d":
      from = shiftLocal(midnight(localNow), { days: -6 });
      break;
    case "30d":
      from = shiftLocal(midnight(localNow), { days: -29 });
      break;
    case "90d":
      from = shiftLocal(midnight(localNow), { days: -89 });
      break;
    case "mtd":
      from = { ...midnight(localNow), day: 1 };
      break;
    case "ytd":
      from = { ...midnight(localNow), month: 1, day: 1 };
      break;
    case "12m":
      from = shiftLocal(midnight(localNow), { years: -1 });
      break;
  }

  return { from: localToInstant(from, timeZone), to };
}

function previousYear(window: AnalyticsWindow, timeZone: string) {
  return {
    from: localToInstant(
      shiftLocal(partsAt(window.from, timeZone), { years: -1 }),
      timeZone,
    ),
    to: localToInstant(
      shiftLocal(partsAt(window.to, timeZone), { years: -1 }),
      timeZone,
    ),
  };
}

export function parseAnalyticsRange(
  params: AnalyticsSearchParams,
  timeZoneValue: unknown,
  now: Date = new Date(),
): AnalyticsRange {
  const timeZone = normalizeAnalyticsTimeZone(timeZoneValue);
  const requestedPreset = one(params.range);
  let preset: AnalyticsRangePreset = RANGE_SET.has(requestedPreset ?? "")
    ? (requestedPreset as AnalyticsRangePreset)
    : "90d";

  const requestedCustom = customWindow(
    one(params.from),
    one(params.to),
    timeZone,
  );
  if (preset === "custom" && !requestedCustom) preset = "90d";
  const current =
    preset === "custom"
      ? (requestedCustom as AnalyticsWindow)
      : presetWindow(preset, now, timeZone);

  const requestedComparison = one(params.compare);
  let comparison: AnalyticsComparison = COMPARISON_SET.has(
    requestedComparison ?? "",
  )
    ? (requestedComparison as AnalyticsComparison)
    : "previous";
  let compare: AnalyticsWindow | null;
  if (comparison === "none") {
    compare = null;
  } else if (comparison === "year") {
    compare = previousYear(current, timeZone);
  } else if (comparison === "custom") {
    compare = customWindow(
      one(params.compareFrom),
      one(params.compareTo),
      timeZone,
    );
    if (!compare) {
      comparison = "previous";
      compare = null;
    }
  } else {
    compare = null;
  }

  if (comparison === "previous" || (comparison === "custom" && !compare)) {
    const duration = current.to.getTime() - current.from.getTime();
    compare = {
      from: new Date(current.from.getTime() - duration),
      to: current.from,
    };
  }

  const currentFrom = dateKey(partsAt(current.from, timeZone));
  const currentTo = dateKey(
    partsAt(new Date(current.to.getTime() - 1), timeZone),
  );

  return {
    preset,
    comparison,
    current,
    compare,
    timeZone,
    label: windowLabel(current, timeZone),
    comparisonLabel: compare ? windowLabel(compare, timeZone) : null,
    customFrom:
      preset === "custom" ? (one(params.from) ?? currentFrom) : currentFrom,
    customTo: preset === "custom" ? (one(params.to) ?? currentTo) : currentTo,
    compareFrom: one(params.compareFrom) ?? "",
    compareTo: one(params.compareTo) ?? "",
  };
}
