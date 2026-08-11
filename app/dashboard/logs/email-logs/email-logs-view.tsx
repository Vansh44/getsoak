"use client";

// Email Logs — a plain, dense, filterable table of every message sent.
//
// A LOG, not a report: no charts, no summaries, one row per send, newest first.
// The question it answers is narrow and specific — "did that email go out, and
// what was in it?" — so the design gets out of the way of scanning and
// searching. Status leads with colour because "show me the failures" is why
// most people open it.

import { useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, Search, X } from "lucide-react";
import { MAILERS, mailerLabel } from "@/lib/email/mailers";
// Pinned locale + zone — an unpinned formatter here hydrates wrong (lib/dates.ts).
import { formatWhen } from "@/lib/dates";
import { ListPagination } from "../../components/list-pagination";
import type { EmailLogRow } from "@/app/actions/email-log-actions";
import { EmailLogDetail } from "./email-log-detail";

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

export function EmailLogsView({
  rows,
  total,
  counts,
  page,
  pageSize,
  status,
  mailer,
  q,
  days,
  error,
  basePath = "/dashboard/logs/email-logs",
  platform = false,
}: {
  rows: EmailLogRow[];
  total: number;
  counts: Record<string, number>;
  page: number;
  pageSize: number;
  status: string;
  mailer: string;
  q: string;
  days: number;
  error?: string;
  basePath?: string;
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
    // Any filter change invalidates the current page number.
    if (key !== "page") params.delete("page");
    startTransition(() => {
      router.push(`${basePath}?${params.toString()}`);
    });
  };

  const hasFilters = Boolean(status || mailer || q || days);

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1>Email logs</h1>
          <p>
            {platform
              ? "Platform delivery history for signup, operator access and StoreMink billing. Real signup codes are redacted; codes for reserved dummy addresses are operator-only and remain visible for test-store creation."
              : "Every email this store has sent — order notifications, campaigns, invites and sign-in codes. Password resets and staff invites are recorded without their contents, because the link inside is a working credential."}
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
              placeholder="Search by recipient or subject"
              aria-label="Search email logs"
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
              <option value="sent">Sent ({counts.sent ?? 0})</option>
              <option value="failed">Failed ({counts.failed ?? 0})</option>
              <option value="skipped">Not sent ({counts.skipped ?? 0})</option>
            </select>

            <select
              value={mailer}
              onChange={(e) => setParam("mailer", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by type"
            >
              <option value="">All types</option>
              {MAILERS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
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

            {hasFilters ? (
              <button
                type="button"
                className="dash-btn dash-btn-ghost dash-btn-sm"
                onClick={() => {
                  setSearch("");
                  startTransition(() => {
                    router.push(basePath);
                  });
                }}
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div className="dash-card-body">
          {error ? (
            <div className="dash-empty">
              <div className="dash-empty-title">
                Couldn&apos;t load email logs
              </div>
              <p className="dash-empty-text">{error}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="dash-empty">
              <Mail className="dash-empty-icon" />
              <div className="dash-empty-title">
                {hasFilters ? "No emails match those filters" : "No emails yet"}
              </div>
              <p className="dash-empty-text">
                {hasFilters
                  ? "Try a wider date range or clear the filters."
                  : "Order confirmations, campaigns and account emails will appear here as they're sent."}
              </p>
            </div>
          ) : (
            // Horizontal scroll on the TABLE, never the page — a log has more
            // columns than a phone has width, and the page body must not shift.
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="dash-table w-full min-w-[880px]">
                <thead>
                  <tr>
                    <th>To</th>
                    <th>From</th>
                    <th>Type</th>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Sent at</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer"
                      onClick={() => setOpenId(row.id)}
                      title="View this email"
                    >
                      <td className="max-w-[260px]">
                        <span className="block truncate font-medium">
                          {row.to}
                        </span>
                        {row.subject ? (
                          <span className="block truncate text-xs text-[var(--dash-text-3)]">
                            {row.subject}
                          </span>
                        ) : null}
                      </td>
                      <td className="max-w-[220px]">
                        <span className="block truncate text-[var(--dash-text-2)]">
                          {row.from}
                        </span>
                      </td>
                      <td className="whitespace-nowrap">
                        {mailerLabel(row.mailer)}
                      </td>
                      <td className="whitespace-nowrap text-[var(--dash-text-2)]">
                        {row.provider}
                      </td>
                      <td className="whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1.5 ${
                            STATUS_STYLE[row.status] ?? ""
                          }`}
                          title={row.error ?? undefined}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              STATUS_DOT[row.status] ?? "bg-slate-400"
                            }`}
                          />
                          {row.status === "skipped" ? "not sent" : row.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-[var(--dash-text-2)]">
                        {formatWhen(row.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ListPagination
            page={page}
            total={total}
            pageSize={pageSize}
            busy={isPending}
            onPage={(next) => setParam("page", String(next))}
          />
        </div>
      </section>

      {openId ? (
        <EmailLogDetail id={openId} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  );
}
