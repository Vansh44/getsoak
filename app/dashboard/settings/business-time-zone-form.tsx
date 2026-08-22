"use client";

import { useActionState } from "react";
import {
  saveAnalyticsTimeZone,
  type AnalyticsSettingsState,
} from "@/app/actions/analytics-settings";
import { COMMON_ANALYTICS_TIME_ZONES } from "@/lib/analytics/range";

const INITIAL_STATE: AnalyticsSettingsState = {};

export function BusinessTimeZoneForm({ timeZone }: { timeZone: string }) {
  const [state, action, pending] = useActionState(
    saveAnalyticsTimeZone,
    INITIAL_STATE,
  );

  return (
    <form
      action={action}
      className="mt-6 rounded-[10px] border border-[#e5e5e5] bg-white p-4"
    >
      <div className="text-[14px] font-medium text-[#1a1a1a]">
        Business time zone
      </div>
      <p className="mt-0.5 text-[13px] leading-[1.5] text-[#6a6a6a]">
        Defines calendar-day boundaries in Analytics. Existing stores default to
        India — Kolkata.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          name="timeZone"
          defaultValue={timeZone}
          className="h-9 min-w-[260px] rounded-md border border-[#d7d7d7] bg-white px-3 text-[13px]"
          aria-label="Business time zone"
        >
          {!COMMON_ANALYTICS_TIME_ZONES.some(
            ([value]) => value === timeZone,
          ) ? (
            <option value={timeZone}>{timeZone}</option>
          ) : null}
          {COMMON_ANALYTICS_TIME_ZONES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending}
          className="h-9 rounded-md bg-[#1a1a1a] px-4 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save time zone"}
        </button>
      </div>
      {state.error ? (
        <p className="mt-2 text-[13px] text-red-700" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="mt-2 text-[13px] text-emerald-700" role="status">
          {state.success}
        </p>
      ) : null}
    </form>
  );
}
