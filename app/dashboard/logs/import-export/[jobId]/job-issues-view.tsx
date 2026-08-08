"use client";

import { useEffect, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import type { JobIssueRow, JobRow } from "@/lib/import-export/jobs";

/** How often a live job re-reads itself. Slow enough to be cheap, fast enough
 *  that the counts visibly move — this is now the page a merchant is SENT to
 *  the moment an import starts, so a frozen screen reads as a stuck import. */
const POLL_MS = 2000;

const STATUS_NOTE: Record<string, string> = {
  completed: "Everything in the file was applied.",
  // ★ Said plainly, because the instinct on seeing "failed" is to re-upload —
  // which on a partial import duplicates everything that already worked.
  partial:
    "Some rows were applied and some weren't. The ones that worked are already saved — re-importing the whole file would duplicate them. Fix the rows below and import just those.",
  failed: "Nothing was applied.",
  cancelled:
    "This was stopped part-way. Rows applied before it stopped are saved.",
  running: "This is still going.",
  pending: "This hasn't started yet.",
};

export function JobIssuesView({
  job,
  issues,
  severity,
  issueCap,
}: {
  job: JobRow;
  issues: JobIssueRow[];
  severity: string;
  issueCap: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const setSeverity = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("severity", value);
    else params.delete("severity");
    startTransition(() => {
      router.push(
        `/dashboard/logs/import-export/${job.id}?${params.toString()}`,
      );
    });
  };

  const errors = issues.filter((i) => i.severity === "error");
  const isImport = job.kind === "import";
  const live = job.status === "running" || job.status === "pending";

  // ★ A LIVE JOB REFRESHES ITSELF. The import runs in the layout and writes its
  // progress server-side chunk by chunk, so without this the merchant lands on
  // a page showing zeroes and has to guess whether to reload. It stops the
  // moment the job does — polling a finished job forever is how a background
  // tab quietly costs a merchant a request every two seconds all afternoon.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [live, router]);

  return (
    <>
      <section className="dash-card">
        <div className="dash-card-body flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Rows in file" value={job.totalRows} />
            {isImport ? (
              <>
                <Stat label="Created" value={job.createdCount} tone="good" />
                <Stat label="Updated" value={job.updatedCount} />
                <Stat label="Skipped" value={job.skippedCount} />
                <Stat
                  label="Failed"
                  value={job.failedCount}
                  tone={job.failedCount > 0 ? "bad" : undefined}
                />
              </>
            ) : (
              <Stat
                label="Rows written"
                value={job.processedRows}
                tone="good"
              />
            )}
          </div>

          {live ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-[13px]">
                <span className="flex items-center gap-2 font-medium text-[var(--dash-text)]">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--dash-accent)]" />
                  Importing…
                </span>
                <span className="text-[var(--dash-text-3)] tabular-nums">
                  {job.processedRows.toLocaleString("en-IN")} of{" "}
                  {job.totalRows.toLocaleString("en-IN")} rows
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--dash-surface-2)]">
                <div
                  className="h-full rounded-full bg-[var(--dash-accent)] transition-[width] duration-300"
                  style={{
                    width: `${job.totalRows > 0 ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100)) : 0}%`,
                  }}
                />
              </div>
              <p className="text-xs text-[var(--dash-text-3)]">
                This page updates itself. You can leave it open or go elsewhere
                in the dashboard — the import keeps running either way. Closing
                the tab stops it.
              </p>
            </div>
          ) : (
            <p className="flex items-start gap-2 text-[13px] text-[var(--dash-text-2)]">
              {job.status === "completed" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
              )}
              <span>{STATUS_NOTE[job.status] ?? job.status}</span>
            </p>
          )}

          {job.error ? (
            <p className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:bg-red-950/40 dark:text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{job.error}</span>
            </p>
          ) : null}

          {/* A log that looks complete when it isn't is worse than one that
              says so — see ISSUE_CAP in lib/import-export/jobs.ts. */}
          {job.droppedIssues > 0 ? (
            <p className="text-xs text-[var(--dash-text-3)]">
              Showing the first {issueCap.toLocaleString("en-IN")} problems.
              Another {job.droppedIssues.toLocaleString("en-IN")} weren&apos;t
              recorded — when this many rows fail it&apos;s usually one thing
              wrong with the whole file rather than {job.droppedIssues} separate
              mistakes.
            </p>
          ) : null}
        </div>
      </section>

      <section className="dash-card">
        <div className="dash-card-header flex-wrap gap-3">
          <div className="text-[13px] font-medium">
            {issues.length === 0
              ? "No problems"
              : `${issues.length.toLocaleString("en-IN")} thing${issues.length === 1 ? "" : "s"} to look at`}
          </div>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            disabled={isPending}
            className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-[7px] text-[13px] text-[var(--dash-text)] outline-none"
            aria-label="Filter by severity"
          >
            <option value="">Everything</option>
            <option value="error">Only what failed ({errors.length})</option>
            <option value="warning">Only the notes</option>
          </select>
        </div>

        <div className="dash-card-body">
          {issues.length === 0 ? (
            <div className="dash-empty">
              <CheckCircle2 className="dash-empty-icon" />
              <div className="dash-empty-title">Nothing went wrong</div>
              <p className="dash-empty-text">
                Every row in this file was handled without a problem.
              </p>
            </div>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="dash-table w-full min-w-[720px]">
                <thead>
                  <tr>
                    <th className="w-[72px]">Row</th>
                    <th className="w-[140px]">Column</th>
                    <th>What happened</th>
                    <th className="w-[180px]">Value in your file</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((issue) => (
                    <tr key={issue.id}>
                      <td className="tabular-nums">
                        {/* Line 0 means the problem is with the FILE (a
                            missing column), not any one row. */}
                        {issue.line > 0 ? (
                          issue.line
                        ) : (
                          <span className="text-[var(--dash-text-3)]">
                            File
                          </span>
                        )}
                      </td>
                      <td className="text-xs text-[var(--dash-text-2)]">
                        {issue.columnName ?? "—"}
                      </td>
                      <td>
                        <span
                          className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                            issue.severity === "error"
                              ? "bg-red-500"
                              : "bg-amber-500"
                          }`}
                        />
                        <span className="text-[13px]">{issue.message}</span>
                      </td>
                      <td className="max-w-[180px]">
                        {issue.value ? (
                          <code className="block truncate rounded bg-[var(--dash-surface-2)] px-1.5 py-0.5 text-xs">
                            {issue.value}
                          </code>
                        ) : (
                          <span className="text-xs text-[var(--dash-text-3)]">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "bad";
}) {
  const color =
    tone === "bad"
      ? "text-red-600 dark:text-red-400"
      : tone === "good"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-[var(--dash-text)]";
  return (
    <div className="rounded-md border border-[var(--dash-border)] px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${color}`}>
        {value.toLocaleString("en-IN")}
      </div>
      <div className="text-xs text-[var(--dash-text-3)]">{label}</div>
    </div>
  );
}
