"use client";

// The audit trail view. Deliberately a plain, dense, filterable log rather
// than a second inbox: the bell answers "what needs me?", this answers "what
// happened, and who did it?".

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Bot, ShieldCheck, ShoppingBag, User } from "lucide-react";
import { EVENT_GROUPS, getEventDef } from "@/lib/notifications/events";
import { formatWhen, relativeDay } from "@/lib/dates";
import { ListPagination } from "../components/list-pagination";
import type { ActivityRow } from "@/app/actions/notification-actions";

const PAGE_SIZE = 50;

const RANGES: { value: string; label: string }[] = [
  { value: "", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

const ACTOR_ICON = {
  customer: ShoppingBag,
  admin: User,
  operator: ShieldCheck,
  system: Bot,
} as const;

const SEVERITY_DOT: Record<string, string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  critical: "bg-red-500",
};

// ★ Both of these used to read the RUNTIME's locale and zone, which is exactly
// what threw "Hydration failed because the server rendered text didn't match
// the client" on this page — server "Aug 6, 10:26 PM" vs client "6 Aug, 22:26".
// `dayKey` had the same bug twice over: its Today/Yesterday comparison used
// `toDateString()`, which is also the machine's zone. Both are pinned in
// lib/dates.ts now; see the note there for why.

/** Group consecutive rows under a date heading, the way a log reads. */
const dayKey = relativeDay;

export function ActivityFeedView({
  events,
  total,
  page,
  group,
  dateRange,
  error,
}: {
  events: ActivityRow[];
  total: number;
  page: number;
  group: string;
  dateRange: string;
  error?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    // Any filter change invalidates the current page number.
    if (key !== "page") params.delete("page");
    startTransition(() => {
      router.push(`/dashboard/logs?${params.toString()}`);
    });
  };

  // Which rows start a new day. Derived up front rather than tracked with a
  // mutable cursor during render — the rows are already in date order.
  const dayHeadings = new Map<string, string>();
  events.reduce((previousDay, event) => {
    const day = dayKey(event.created_at);
    if (day !== previousDay) dayHeadings.set(event.id, day);
    return day;
  }, "");

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1>Activity</h1>
          <p>
            Every action taken in this store, by staff, shoppers, and the
            system.
          </p>
        </div>
      </header>

      <section className="dash-card">
        <div className="dash-card-header flex-wrap gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={group}
              onChange={(e) => setParam("group", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {EVENT_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <select
              value={dateRange}
              onChange={(e) => setParam("range", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by date"
            >
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <span className="text-[12.5px] text-[var(--dash-text-3)]">
            {total.toLocaleString()} event{total === 1 ? "" : "s"}
          </span>
        </div>

        <div className="dash-card-body">
          {error ? (
            <div className="dash-empty">
              <div className="dash-empty-title">
                Couldn&apos;t load activity
              </div>
              <p className="dash-empty-text">{error}</p>
            </div>
          ) : events.length === 0 ? (
            <div className="dash-empty">
              <Activity className="dash-empty-icon" />
              <div className="dash-empty-title">Nothing here yet</div>
              <p className="dash-empty-text">
                Orders, product edits, and sign-ins will appear here as they
                happen.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {events.map((event) => {
                const def = getEventDef(event.type);
                const Icon =
                  ACTOR_ICON[event.actor_type as keyof typeof ACTOR_ICON] ??
                  Bot;
                const day = dayHeadings.get(event.id);

                return (
                  <li key={event.id}>
                    {day && (
                      <div className="sticky top-0 z-10 bg-[var(--dash-surface)] pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--dash-text-3)] first:pt-0">
                        {day}
                      </div>
                    )}
                    <div className="flex items-start gap-3 border-b border-[var(--dash-border)] py-3 last:border-b-0">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--dash-surface-2)] text-[var(--dash-text-2)]">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--dash-text)]">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                SEVERITY_DOT[def?.severity ?? "info"]
                              }`}
                              aria-hidden
                            />
                            {def?.label ?? event.type}
                          </span>
                          {event.subject_label && (
                            <span className="truncate text-[13px] text-[var(--dash-text-2)]">
                              {event.subject_label}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[12px] text-[var(--dash-text-3)]">
                          {event.actor_label ??
                            (event.actor_type === "system"
                              ? "System"
                              : "Unknown")}
                          {" · "}
                          {formatWhen(event.created_at)}
                          {def?.group ? ` · ${def.group}` : ""}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <ListPagination
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
            busy={isPending}
            onPage={(next) => setParam("page", String(next))}
          />
        </div>
      </section>
    </div>
  );
}
