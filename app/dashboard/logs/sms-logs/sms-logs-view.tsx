"use client";

// SMS Logs — the Email Logs table, with the one column email doesn't need.
//
// ★ `Segments` IS THE COLUMN THAT EARNS ITS PLACE. An SMS is billed per
// segment, and one character outside GSM-7 — an emoji, curly quotes pasted from
// a word processor, or ₹ — re-prices the WHOLE message from 160 characters per
// segment to 70. So a template that costs one segment costs three the day
// someone adds a rupee sign, and without the number here the merchant sees only
// a Twilio bill that tripled with no explanation. The header carries the total
// for the current filter for the same reason.

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageSquare, Search } from "lucide-react";
// Pinned locale + zone — an unpinned formatter here hydrates wrong (lib/dates.ts).
import { formatWhen } from "@/lib/dates";
import { ListPagination } from "../../components/list-pagination";
import type { SmsLogRow } from "@/app/actions/sms-log-actions";

const RANGES: { value: string; label: string }[] = [
  { value: "0", label: "All time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

const STATUS_STYLE: Record<string, string> = {
  sent: "text-emerald-700 dark:text-emerald-400",
  failed: "text-red-700 dark:text-red-400",
  skipped: "text-amber-700 dark:text-amber-400",
};

const STATUS_DOT: Record<string, string> = {
  sent: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-amber-500",
};

export function SmsLogsView({
  rows,
  total,
  counts,
  segments,
  page,
  pageSize,
  status,
  q,
  days,
  error,
  platform = false,
}: {
  rows: SmsLogRow[];
  total: number;
  counts: { sent: number; failed: number; skipped: number };
  segments: number;
  page: number;
  pageSize: number;
  status: string;
  q: string;
  days: number;
  error?: string;
  /** Operator console (store_id IS NULL) rather than one store's log. The
   *  EmailLogsView contract, mirrored — without it this page told an operator
   *  about "this store", which on the platform console names nothing. */
  platform?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(q);
  const [openId, setOpenId] = useState<string | null>(null);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "0") params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    startTransition(() => {
      router.push(`/dashboard/logs/sms-logs?${params.toString()}`);
    });
  };

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1>SMS logs</h1>
          <p>
            {platform
              ? "Every text StoreMink itself has sent. Merchants' own messages to their shoppers are logged in their store, not here — SMS is a per-store connection."
              : "Every text this store has sent. A message blocked by a carrier for not matching its DLT template arrives here as sent — carriers drop those silently, so a delivery report is the only place it shows."}
          </p>
        </div>
      </header>

      <section className="dash-card">
        <div className="dash-card-header flex-wrap gap-3">
          <form
            className="relative min-w-[220px] flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setParam("q", search.trim());
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--dash-text-3)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by number or notification"
              aria-label="Search SMS logs"
              className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] py-[7px] pl-9 pr-3 text-[13px] text-[var(--dash-text)] outline-none"
            />
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(e) => setParam("status", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="sent">Sent ({counts.sent})</option>
              <option value="failed">Failed ({counts.failed})</option>
              <option value="skipped">Not sent ({counts.skipped})</option>
            </select>

            <select
              value={String(days || 0)}
              onChange={(e) => setParam("days", e.target.value)}
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

            {/* What the merchant was billed for this window. */}
            <span className="rounded-md border border-[var(--dash-border)] px-3 py-[7px] text-[13px] text-[var(--dash-text-2)]">
              {segments} segment{segments === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        {error ? (
          <p className="px-5 py-8 text-center text-[13px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--dash-text-3)]">
            <MessageSquare className="mx-auto mb-2 h-5 w-5 opacity-40" />
            {platform ? (
              <>
                No platform messages — and there cannot be any yet.
                <span className="mt-1.5 block">
                  StoreMink has no SMS sender of its own. The one-time code sent
                  during signup comes from Firebase phone auth, which Google
                  delivers on its own infrastructure and which never passes
                  through this system, so it leaves no row here.
                </span>
              </>
            ) : (
              "No messages yet."
            )}
          </p>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table dash-table-wide">
              <thead>
                <tr>
                  <th>To</th>
                  <th>Notification</th>
                  <th>Sender</th>
                  <th>Segments</th>
                  <th>Status</th>
                  <th>Sent at</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setOpenId(openId === row.id ? null : row.id)}
                    className="cursor-pointer"
                  >
                    <td className="font-mono text-[12px]">{row.to_phone}</td>
                    <td>{row.event_key ?? "—"}</td>
                    <td className="font-mono text-[12px]">
                      {row.sender_header ?? "—"}
                    </td>
                    <td>{row.segments}</td>
                    <td>
                      <span
                        className={`inline-flex items-center gap-1.5 ${
                          STATUS_STYLE[row.status] ?? ""
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            STATUS_DOT[row.status] ?? "bg-neutral-400"
                          }`}
                        />
                        {row.status}
                      </span>
                      {/* The reason lives next to the status, because "failed"
                          on its own is not actionable. */}
                      {row.error && openId === row.id && (
                        <span className="mt-1 block text-[12px] text-[var(--dash-text-3)]">
                          {row.error}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      {formatWhen(row.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* The body is shown on the row you opened rather than in a drawer: an
            SMS is at most a few hundred characters, so a panel would be more
            chrome than content. */}
        {openId && (
          <div className="border-t border-[var(--dash-border)] px-5 py-4">
            <p className="mb-1 text-[12px] font-medium text-[var(--dash-text-2)]">
              Message
            </p>
            <p className="whitespace-pre-wrap text-[13px] text-[var(--dash-text)]">
              {rows.find((r) => r.id === openId)?.body ?? "(not recorded)"}
            </p>
          </div>
        )}

        <ListPagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPage={(p) => setParam("page", String(p))}
        />
      </section>
    </div>
  );
}
