"use client";

// Failures — one table for everything that didn't work.
//
// Deliberately NOT a dashboard: no counts, no trend, no chart. Someone opens
// this because something is wrong right now, so it is the same dense, dated,
// scannable table as Email logs, and every row links to the place the problem
// can actually be dealt with.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ExternalLink } from "lucide-react";
// ★ ./failure-types, NOT ./failures — the latter imports the database client,
// which drags `pg` (and `fs`) into the browser bundle and fails the build.
import { FAILURE_SOURCE_META, type FailureRow } from "@/lib/logs/failure-types";
// Pinned locale + zone — an unpinned formatter here hydrates wrong (lib/dates.ts).
import { formatWhen } from "@/lib/dates";

const SOURCE_STYLE: Record<string, string> = {
  email: "text-sky-700 dark:text-sky-400",
  notification: "text-violet-700 dark:text-violet-400",
  refund: "text-red-700 dark:text-red-400",
  import: "text-amber-700 dark:text-amber-400",
  payment: "text-red-700 dark:text-red-400",
};

export function FailuresView({
  rows,
  source,
  failedSources,
  storeNames,
}: {
  rows: FailureRow[];
  source: string;
  failedSources: string[];
  /** Operator view only: store id → name, adds a Store column. */
  storeNames?: Record<string, string>;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function setSource(next: string) {
    const sp = new URLSearchParams(params.toString());
    if (next) sp.set("source", next);
    else sp.delete("source");
    router.push(`?${sp.toString()}`);
  }

  return (
    <div className="dash-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-black/5 p-4 dark:border-white/10">
        <h1 className="mr-auto text-base font-semibold">Failures</h1>
        <div className="flex flex-wrap gap-1">
          <FilterChip active={!source} onClick={() => setSource("")}>
            All
          </FilterChip>
          {FAILURE_SOURCE_META.map((s) => (
            <FilterChip
              key={s.key}
              active={source === s.key}
              title={s.blurb}
              onClick={() => setSource(s.key)}
            >
              {s.label}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* A source we couldn't read is stated, never silently dropped — a short
          list that looks clean is the one wrong answer this view must not give. */}
      {failedSources.length > 0 && (
        <p className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          Couldn&apos;t read {failedSources.join(", ")} — this list is
          incomplete.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-black/50 dark:text-white/50">
          Nothing has failed{source ? ` in ${source}` : ""}. That&apos;s the
          right answer.
        </p>
      ) : (
        <div className="dash-table-wrap overflow-x-auto">
          <table className="dash-table w-full">
            <thead>
              <tr>
                <th>What</th>
                <th>Source</th>
                {storeNames && <th>Store</th>}
                <th>Detail</th>
                <th>When</th>
                <th className="dash-col-actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.title}</td>
                  <td className={SOURCE_STYLE[r.source] ?? ""}>{r.source}</td>
                  {storeNames && (
                    <td>{(r.storeId && storeNames[r.storeId]) || "—"}</td>
                  )}
                  <td
                    className="max-w-md truncate text-black/60 dark:text-white/60"
                    title={r.detail ?? ""}
                  >
                    {r.detail || "—"}
                  </td>
                  <td className="whitespace-nowrap tabular-nums">
                    {formatWhen(r.occurredAt)}
                  </td>
                  <td className="dash-col-actions">
                    {r.href && (
                      <Link
                        href={r.href}
                        className="inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline"
                      >
                        Open <ExternalLink className="size-3" aria-hidden />
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={[
        "rounded-full px-3 py-1 text-sm transition-colors",
        active
          ? "bg-black text-white dark:bg-white dark:text-black"
          : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
