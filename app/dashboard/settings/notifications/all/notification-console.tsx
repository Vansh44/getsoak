"use client";

// The notification list — one row per notification, filterable by category and
// by channel, searchable by name. Clicking a row opens its full configuration.
//
// Filters live in the URL so a merchant can bookmark "everything that emails"
// and so the back button behaves. Counts on the tabs reflect the CATALOG, not
// the current search — a tab whose number moves as you type is worse than
// useless.

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BellOff,
  ChevronLeft,
  Search,
  SlidersHorizontal,
  Store,
  User,
  Users,
} from "lucide-react";
import { CHANNELS } from "@/lib/notifications/channels";
import { EVENT_GROUPS, eventKeySlug } from "@/lib/notifications/events";
import type { ConsoleRow } from "@/app/actions/notification-actions";

const CHANNEL_LABEL = new Map<string, string>(
  CHANNELS.map((c) => [c.key, c.label]),
);

// Audience is the FIRST question a merchant is answering ("is this for my team
// or my customers?"), so it gets its own filter alongside category.
const AUDIENCE_TABS = [
  { key: "team", label: "To my team" },
  { key: "customer", label: "To customers" },
];

function ChannelBadges({ channels }: { channels: string[] }) {
  if (channels.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-[var(--dash-text-3)]">
        <BellOff className="h-3.5 w-3.5" />
        Off
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {channels.map((key) => (
        <span
          key={key}
          className="dash-badge-grey rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
        >
          {CHANNEL_LABEL.get(key) ?? key}
        </span>
      ))}
    </span>
  );
}

/** Who a notification reaches — the column that was missing, and the reason
 *  merchants couldn't find where customer emails were configured. */
function AudienceBadges({ row }: { row: ConsoleRow }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {row.audiences.map((audience) => (
        <span
          key={audience.key}
          title={audience.description}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ${
            audience.key === "team" ? "dash-badge-blue" : "dash-badge-violet"
          }`}
        >
          {audience.key === "team" ? (
            <Store className="h-3 w-3" />
          ) : (
            <User className="h-3 w-3" />
          )}
          {audience.label}
        </span>
      ))}
    </span>
  );
}

/** Every channel switched on across all of a row's audiences. */
function enabledChannelsOf(row: ConsoleRow): string[] {
  return [...new Set(row.audiences.flatMap((a) => a.enabledChannels))];
}

function recipientSummary(row: ConsoleRow): string {
  const team = row.audiences.find((a) => a.key === "team");
  if (!team?.routing) return "The customer";
  if (team.routing.mode === "roles") {
    const n = team.routing.roles.length;
    return `${n} role${n === 1 ? "" : "s"}`;
  }
  if (team.routing.mode === "admins") {
    const n = team.routing.admins.length;
    return `${n} ${n === 1 ? "person" : "people"}`;
  }
  return "Everyone eligible";
}

export function NotificationConsole({
  rows,
  counts,
  total,
  canManage,
  category,
  audience,
  channel,
  query,
  error,
}: {
  rows: ConsoleRow[];
  counts: Record<string, number>;
  total: number;
  canManage: boolean;
  category: string;
  audience: string;
  channel: string;
  query: string;
  error?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(query);

  const go = (patch: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    startTransition(() => {
      router.push(`/dashboard/settings/notifications/all?${params.toString()}`);
    });
  };

  const openRow = (key: string) =>
    startTransition(() => {
      router.push(`/dashboard/settings/notifications/${eventKeySlug(key)}`);
    });

  // Debounced search so every keystroke isn't a navigation.
  useEffect(() => {
    if (search === query) return;
    const handle = setTimeout(() => go({ q: search }), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const tabs = [
    { key: "", label: "All", count: counts.all ?? total },
    ...EVENT_GROUPS.filter((g) => counts[g]).map((g) => ({
      key: g,
      label: g,
      count: counts[g],
    })),
  ];

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1>
            All notifications{" "}
            <span className="ml-1 align-middle text-[13px] font-medium text-[var(--dash-text-3)]">
              {total}
            </span>
          </h1>
          <p>
            Choose what your store notifies about, who receives it, and what it
            says. Everything is recorded in{" "}
            <Link href="/dashboard/activity" className="underline">
              Activity
            </Link>{" "}
            whether or not it notifies anyone.
          </p>
        </div>
        <Link
          href="/dashboard/settings/notifications"
          className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to overview
        </Link>
      </header>

      <section className="dash-card">
        {/* Category tabs */}
        <div className="dash-filter-tabs flex-wrap">
          {tabs.map((tab) => (
            <button
              key={tab.key || "all"}
              type="button"
              className={`dash-filter-tab ${category === tab.key ? "active" : ""}`}
              onClick={() => go({ category: tab.key, page: "" })}
              disabled={isPending}
            >
              {tab.label}
              <span className="dash-tab-count">{tab.count}</span>
            </button>
          ))}
          {AUDIENCE_TABS.filter((a) => counts[`audience:${a.key}`]).map((a) => (
            <button
              key={a.key}
              type="button"
              className={`dash-filter-tab ${audience === a.key ? "active" : ""}`}
              onClick={() =>
                go({ audience: audience === a.key ? "" : a.key, page: "" })
              }
              disabled={isPending}
            >
              {a.label}
              <span className="dash-tab-count">
                {counts[`audience:${a.key}`]}
              </span>
            </button>
          ))}
          {CHANNELS.filter((c) => counts[`channel:${c.key}`]).map((c) => (
            <button
              key={c.key}
              type="button"
              className={`dash-filter-tab ${channel === c.key ? "active" : ""}`}
              onClick={() =>
                go({ channel: channel === c.key ? "" : c.key, page: "" })
              }
              disabled={isPending}
            >
              {c.label} enabled
              <span className="dash-tab-count">
                {counts[`channel:${c.key}`]}
              </span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="dash-card-header">
          <div className="flex w-full items-center gap-2 rounded-md border border-[var(--dash-border)] px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name"
              className="w-full border-none bg-transparent text-[13.5px] text-[var(--dash-text)] outline-none placeholder:text-[var(--dash-text-3)]"
            />
          </div>
        </div>

        <div className="dash-card-body">
          {error ? (
            <div className="dash-empty">
              <div className="dash-empty-title">
                Couldn&apos;t load notifications
              </div>
              <p className="dash-empty-text">{error}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="dash-empty">
              <SlidersHorizontal className="dash-empty-icon" />
              <div className="dash-empty-title">Nothing matches</div>
              <p className="dash-empty-text">
                Try a different search or category.
              </p>
            </div>
          ) : (
            <table className="dash-table dash-table-wide">
              <thead>
                <tr>
                  <th>Notification</th>
                  <th>Goes to</th>
                  <th>Channels</th>
                  <th>Recipients</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  // The WHOLE row navigates (the orders/products list pattern)
                  // — a row that shows a pointer cursor but only responds on
                  // one cell is just a broken row. The title stays a real
                  // anchor so middle-click / open-in-new-tab still work, and
                  // stops propagation so it doesn't navigate twice.
                  <tr
                    key={row.key}
                    className="cursor-pointer"
                    onClick={() => openRow(row.key)}
                  >
                    <td>
                      <Link
                        href={`/dashboard/settings/notifications/${eventKeySlug(row.key)}`}
                        className="block no-underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="dash-cell-title flex items-center gap-2">
                          {row.displayName}
                          {!row.isEnabled && (
                            <span className="dash-badge-grey rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase">
                              Off
                            </span>
                          )}
                          {row.isCustom && (
                            <span
                              className="dash-badge-amber rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                              title="Registered by StoreMink but not triggered by anything yet."
                            >
                              No trigger
                            </span>
                          )}
                        </span>
                        <span className="dash-cell-sub">{row.description}</span>
                      </Link>
                    </td>
                    <td>
                      <AudienceBadges row={row} />
                    </td>
                    <td>
                      <ChannelBadges channels={enabledChannelsOf(row)} />
                    </td>
                    <td className="text-[13px] text-[var(--dash-text-2)]">
                      <span className="inline-flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5 text-[var(--dash-text-3)]" />
                        {recipientSummary(row)}
                      </span>
                    </td>
                    <td className="text-[13px] text-[var(--dash-text-2)]">
                      {row.category}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {!canManage && (
        <p className="text-[12.5px] text-[var(--dash-text-3)]">
          You can view these settings but not change them. Ask an owner for
          “manage” on Notifications in Roles &amp; Permissions.
        </p>
      )}
    </div>
  );
}
