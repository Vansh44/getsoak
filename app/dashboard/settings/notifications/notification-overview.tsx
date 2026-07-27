"use client";

// The notification overview — two jobs, not a matrix.
//
// Each section answers one question a merchant actually arrives with:
//
//   Customer emails → "what does my shopper receive, and what does it say?"
//   Team alerts     → "who on my team gets told, and about what?"
//
// The two lists deliberately look DIFFERENT, because the jobs are different:
// customer rows lead with the message (there's only ever one recipient), team
// rows lead with the recipients (the copy matters less than who's on the hook).
// That asymmetry is the whole point — a single uniform grid hid it, which is
// why the page was confusing.

import { useState } from "react";
import Link from "next/link";
import {
  Bell,
  ChevronRight,
  Mail,
  Settings2,
  Store,
  User,
  Users,
} from "lucide-react";
import { eventKeySlug } from "@/lib/notifications/events";
import { CHANNELS } from "@/lib/notifications/channels";
import type {
  ConsoleRow,
  DeliveryFailure,
} from "@/app/actions/notification-actions";
import { DeliveryHealth } from "./delivery-health";

const CHANNEL_LABEL = new Map<string, string>(
  CHANNELS.map((c) => [c.key, c.label]),
);

/** Links carry the audience, so opening a row from "Customer emails" lands in
 *  the customer context and the detail page shows no audience switcher — you
 *  already answered that question by choosing a tab. */
function href(key: string, audience: string) {
  return `/dashboard/settings/notifications/${eventKeySlug(key)}?audience=${audience}`;
}

function Row({
  row,
  audience,
  right,
  muted,
}: {
  row: ConsoleRow;
  audience: string;
  right: React.ReactNode;
  muted?: string;
}) {
  return (
    <Link
      href={href(row.key, audience)}
      className="flex items-center gap-4 border-t border-[var(--dash-border)] px-1 py-3.5 no-underline transition-colors first:border-t-0 hover:bg-[var(--dash-surface-2)]"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--dash-text)]">
          {row.displayName}
          {!row.isEnabled && (
            <span className="dash-badge-grey rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase">
              Off
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-[var(--dash-text-3)]">
          {muted ?? row.description}
        </span>
      </span>
      <span className="hidden shrink-0 text-[12.5px] text-[var(--dash-text-2)] sm:block">
        {right}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
    </Link>
  );
}

function channelSummary(keys: string[]): string {
  if (keys.length === 0) return "Not sending";
  return keys.map((k) => CHANNEL_LABEL.get(k) ?? k).join(" + ");
}

function recipientSummary(row: ConsoleRow): string {
  const team = row.audiences.find((a) => a.key === "team");
  if (!team?.routing) return "—";
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

export function NotificationOverview({
  rows,
  total,
  canManage,
  error,
  delivery = [],
  deliveryTotal = 0,
}: {
  rows: ConsoleRow[];
  total: number;
  canManage: boolean;
  error?: string;
  delivery?: DeliveryFailure[];
  deliveryTotal?: number;
}) {
  const [tab, setTab] = useState<"customer" | "team">("customer");

  // A notification reaching both audiences appears under BOTH tabs — each
  // showing only that audience's settings.
  const customerRows = rows.filter((r) =>
    r.audiences.some((a) => a.key === "customer"),
  );
  const teamRows = rows.filter((r) =>
    r.audiences.some((a) => a.key === "team"),
  );

  if (error) {
    return (
      <div className="dash-page-enter flex flex-col gap-4">
        <header className="dash-page-header row">
          <div>
            <h1>Notifications</h1>
          </div>
        </header>
        <section className="dash-card">
          <div className="dash-card-body">
            <div className="dash-empty">
              <div className="dash-empty-title">
                Couldn&apos;t load notifications
              </div>
              <p className="dash-empty-text">{error}</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="dash-page-enter flex flex-col gap-5">
      <header className="dash-page-header row">
        <div>
          <h1>Notifications</h1>
          <p>
            The emails your customers receive, and the alerts your team gets.
            Everything that happens is recorded in{" "}
            <Link href="/dashboard/activity" className="underline">
              Activity
            </Link>{" "}
            whether or not it notifies anyone.
          </p>
        </div>
        <Link
          href="/dashboard/settings/notifications/me"
          className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
        >
          <Bell className="h-4 w-4" />
          My notifications
        </Link>
      </header>

      {/* Only rendered when mail actually failed — see delivery-health.tsx. */}
      <DeliveryHealth
        failures={delivery}
        total={deliveryTotal}
        canManage={canManage}
      />

      {/* One tab at a time: a merchant is doing one of the two jobs, not both. */}
      <div className="dash-filter-tabs">
        <button
          type="button"
          className={`dash-filter-tab ${tab === "customer" ? "active" : ""}`}
          onClick={() => setTab("customer")}
        >
          <User className="mr-1.5 h-3.5 w-3.5" />
          Customer emails
          <span className="dash-tab-count">{customerRows.length}</span>
        </button>
        <button
          type="button"
          className={`dash-filter-tab ${tab === "team" ? "active" : ""}`}
          onClick={() => setTab("team")}
        >
          <Store className="mr-1.5 h-3.5 w-3.5" />
          Team alerts
          <span className="dash-tab-count">{teamRows.length}</span>
        </button>
      </div>

      <section className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">
              {tab === "customer" ? "Customer emails" : "Team alerts"}
            </div>
            <div className="dash-card-sub">
              {tab === "customer"
                ? "What your shoppers receive. Open one to change its wording."
                : "Who gets told when something happens in your store."}
            </div>
          </div>
        </div>
        <div className="dash-card-body pt-0">
          {/* The two lists are shaped to their jobs: a customer row leads with
              the MESSAGE (there is only ever one recipient), a team row leads
              with the RECIPIENTS (the copy matters less than who's on the hook). */}
          {tab === "customer" ? (
            customerRows.length === 0 ? (
              <p className="py-3 text-[13px] text-[var(--dash-text-3)]">
                No customer-facing notifications yet.
              </p>
            ) : (
              customerRows.map((row) => {
                const audience = row.audiences.find(
                  (a) => a.key === "customer",
                )!;
                return (
                  <Row
                    key={row.key}
                    row={row}
                    audience="customer"
                    right={
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5 text-[var(--dash-text-3)]" />
                        {channelSummary(audience.enabledChannels)}
                      </span>
                    }
                  />
                );
              })
            )
          ) : teamRows.length === 0 ? (
            <p className="py-3 text-[13px] text-[var(--dash-text-3)]">
              No team alerts yet.
            </p>
          ) : (
            teamRows.map((row) => {
              const audience = row.audiences.find((a) => a.key === "team")!;
              return (
                <Row
                  key={row.key}
                  row={row}
                  audience="team"
                  muted={channelSummary(audience.enabledChannels)}
                  right={
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-[var(--dash-text-3)]" />
                      {recipientSummary(row)}
                    </span>
                  }
                />
              );
            })
          )}
        </div>
      </section>

      {/* ── The machinery, one click away ─────────────────────────────────── */}
      <Link
        href="/dashboard/settings/notifications/all"
        className="flex items-center gap-3 rounded-[var(--dash-radius)] border border-[var(--dash-border)] bg-[var(--dash-surface)] px-4 py-3.5 no-underline transition-colors hover:border-[var(--dash-border-hover)]"
      >
        <Settings2 className="h-4 w-4 shrink-0 text-[var(--dash-text-2)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-[var(--dash-text)]">
            All notifications
          </span>
          <span className="mt-0.5 block text-[12.5px] text-[var(--dash-text-3)]">
            Every notification with filters, search, and channel-by-channel
            control — {total} in total.
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
      </Link>

      {!canManage && (
        <p className="text-[12.5px] text-[var(--dash-text-3)]">
          You can view these settings but not change them. Ask an owner for
          “manage” on Notifications in Roles &amp; Permissions.
        </p>
      )}
    </div>
  );
}
