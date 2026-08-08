"use client";

// The import/export history — one row per job, newest first.
//
// A LOG, like Email logs beside it: no charts, no summaries. It answers two
// questions and gets out of the way — "did that import work?" and, when it
// didn't, "which rows and why?" (that second one lives one click deeper, on the
// job page, because a table of 900 row errors is not a history).

import { useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  FileSpreadsheet,
  X,
} from "lucide-react";
import { ListPagination } from "../../components/list-pagination";
// The 4th copy of this formatter lived here; it was already pinned, and now
// there is one implementation for the whole hub.
import { formatWhen } from "@/lib/dates";
import { RESOURCES, getResource } from "@/lib/import-export/resources";
import type { JobRow } from "@/lib/import-export/jobs";

const PAGE_SIZE = 25;

// `partial` reads as a warning rather than a failure on purpose — it means the
// import DID work for most rows, and calling it "failed" is what makes a
// merchant re-upload and duplicate everything that already landed.
const STATUS_STYLE: Record<string, string> = {
  completed: "text-emerald-700 dark:text-emerald-400",
  partial: "text-amber-700 dark:text-amber-400",
  failed: "text-red-700 dark:text-red-400",
  cancelled: "text-[var(--dash-text-3)]",
  running: "text-[var(--dash-accent)]",
  pending: "text-[var(--dash-text-3)]",
};

const STATUS_DOT: Record<string, string> = {
  completed: "bg-emerald-500",
  partial: "bg-amber-500",
  failed: "bg-red-500",
  cancelled: "bg-[var(--dash-text-3)]",
  running: "bg-[var(--dash-accent)]",
  pending: "bg-[var(--dash-text-3)]",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "Finished",
  partial: "Finished with errors",
  failed: "Failed",
  cancelled: "Stopped",
  running: "Running",
  pending: "Starting",
};

/** One line summarising what a job did. */
function summarise(job: JobRow): string {
  if (job.kind === "export") {
    return `${job.processedRows.toLocaleString("en-IN")} rows`;
  }
  const parts: string[] = [];
  if (job.createdCount) parts.push(`${job.createdCount} created`);
  if (job.updatedCount) parts.push(`${job.updatedCount} updated`);
  if (job.skippedCount) parts.push(`${job.skippedCount} skipped`);
  if (job.failedCount) parts.push(`${job.failedCount} failed`);
  return parts.length ? parts.join(" · ") : "Nothing changed";
}

export function JobsView({
  rows,
  total,
  page,
  kind,
  resource,
  error,
}: {
  rows: JobRow[];
  total: number;
  page: number;
  kind: string;
  resource: string;
  error?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    if (key !== "page") params.delete("page");
    startTransition(() => {
      router.push(`/dashboard/logs/import-export?${params.toString()}`);
    });
  };

  const hasFilters = Boolean(kind || resource);

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1>Imports &amp; exports</h1>
          <p>
            Every CSV this store has imported or exported, and what happened to
            each row. Open a job to see the rows it couldn&apos;t import and
            why.
          </p>
        </div>
      </header>

      <section className="dash-card">
        <div className="dash-card-header flex-wrap gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={kind}
              onChange={(e) => setParam("kind", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by type"
            >
              <option value="">Imports and exports</option>
              <option value="import">Imports only</option>
              <option value="export">Exports only</option>
            </select>

            <select
              value={resource}
              onChange={(e) => setParam("resource", e.target.value)}
              disabled={isPending}
              className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
              aria-label="Filter by data"
            >
              <option value="">All data</option>
              {RESOURCES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>

            {hasFilters ? (
              <button
                type="button"
                className="dash-btn dash-btn-ghost dash-btn-sm"
                onClick={() =>
                  startTransition(() => {
                    router.push("/dashboard/logs/import-export");
                  })
                }
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
                Couldn&apos;t load the history
              </div>
              <p className="dash-empty-text">{error}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="dash-empty">
              <FileSpreadsheet className="dash-empty-icon" />
              <div className="dash-empty-title">
                {hasFilters
                  ? "Nothing matches those filters"
                  : "No imports or exports yet"}
              </div>
              <p className="dash-empty-text">
                {hasFilters
                  ? "Try clearing the filters."
                  : "Import or export a CSV from your Products, Categories, Inventory, Orders or Coupons page and it will show up here."}
              </p>
            </div>
          ) : (
            // Scroll the TABLE, never the page — the dashboard body must not
            // shift sideways.
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="dash-table w-full min-w-[820px]">
                <thead>
                  <tr>
                    <th>What</th>
                    <th>File</th>
                    <th>Result</th>
                    <th>Status</th>
                    <th>Who</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((job) => {
                    const def = getResource(job.resource);
                    return (
                      <tr key={job.id}>
                        <td>
                          <Link
                            href={`/dashboard/logs/import-export/${job.id}`}
                            className="flex items-center gap-2 font-medium hover:underline"
                          >
                            {job.kind === "import" ? (
                              <ArrowUpFromLine className="h-3.5 w-3.5 text-[var(--dash-text-3)]" />
                            ) : (
                              <ArrowDownToLine className="h-3.5 w-3.5 text-[var(--dash-text-3)]" />
                            )}
                            {job.kind === "import" ? "Import" : "Export"}
                            {" · "}
                            {def?.label ?? job.resource}
                          </Link>
                        </td>
                        <td className="max-w-[220px]">
                          <span className="block truncate text-xs text-[var(--dash-text-3)]">
                            {job.filename ?? "—"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          {summarise(job)}
                          {job.warningCount > 0 ? (
                            <span className="ml-1 text-[var(--dash-text-3)]">
                              ({job.warningCount} note
                              {job.warningCount === 1 ? "" : "s"})
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <span
                            className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${
                              STATUS_STYLE[job.status] ?? ""
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                STATUS_DOT[job.status] ??
                                "bg-[var(--dash-text-3)]"
                              }`}
                            />
                            {STATUS_LABEL[job.status] ?? job.status}
                          </span>
                        </td>
                        <td className="max-w-[180px]">
                          <span className="block truncate text-xs text-[var(--dash-text-3)]">
                            {job.actorEmail ?? "—"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-xs text-[var(--dash-text-3)]">
                          {formatWhen(job.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <ListPagination
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          busy={isPending}
          onPage={(next) => setParam("page", String(next))}
        />
      </section>
    </div>
  );
}
