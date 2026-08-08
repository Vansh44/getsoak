// Dashboard date formatting — pinned, because the alternative hydrates wrong.
//
// ── ★ WHY BOTH THE LOCALE AND THE ZONE ARE PINNED ─────────────────────────
// `toLocaleString(undefined, …)` asks the runtime for its locale and zone. In
// a "use client" component that runs TWICE: once on the server during SSR
// (Node — `en-US`, and UTC on Cloud Run) and once in the browser (the user's
// own). The two disagree, so React throws
//
//     Hydration failed because the server rendered text didn't match the client
//       + 6 Aug, 22:26      (client)
//       - Aug 6, 10:26 PM   (server)
//
// which is a real, reproducible error on the logs pages, not a cosmetic one.
// Even where it doesn't hydrate — a pure server component — the unpinned form
// silently renders every timestamp in UTC, so a 3:12 pm event reads "9:42 am"
// with nothing to say it isn't local.
//
// `lib/notifications/format.ts` already pins for exactly this reason (§24) and
// so does the import/export log; this is the shared version so the next table
// doesn't get a fourth hand-written copy that forgets. Asia/Kolkata is the
// India-first default the dashboard already uses, until per-store timezones
// exist.

/** The one zone every dashboard timestamp is rendered in. */
export const DASHBOARD_TIME_ZONE = "Asia/Kolkata";

/** The one locale. Pinned so SSR and the browser agree on field order. */
export const DASHBOARD_LOCALE = "en-IN";

/**
 * Date + time, compact, for a log table row: "06 Aug 2026, 10:26 pm".
 *
 * Returns "" for null/invalid rather than "Invalid Date" — a blank cell reads
 * as "no timestamp", which is the truth, while "Invalid Date" reads as a bug
 * in the row's data.
 */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(DASHBOARD_LOCALE, {
    timeZone: DASHBOARD_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The calendar day an instant falls on, IN THE PINNED ZONE, as "YYYY-MM-DD".
 *
 * `en-CA` is the reliable way to get that ordering out of Intl. The naive
 * alternative — `d.toDateString()` — reads the MACHINE's zone, so a log row
 * from 19:00 UTC lands on the 6th during SSR and the 7th in an Indian browser:
 * the same hydration mismatch again, wearing a different hat.
 */
export function zonedDayKey(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: DASHBOARD_TIME_ZONE });
}

/**
 * A day heading: "Today", "Yesterday", or "6 August 2026" — all decided in the
 * pinned zone, so the server and the browser agree on which day it is.
 */
export function relativeDay(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "";
  const key = zonedDayKey(iso);
  if (!key) return "";
  if (key === zonedDayKey(now)) return "Today";
  if (key === zonedDayKey(now.getTime() - 86_400_000)) return "Yesterday";
  return formatDay(iso);
}

/** Date only, for a day heading: "6 August 2026". */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(DASHBOARD_LOCALE, {
    timeZone: DASHBOARD_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
