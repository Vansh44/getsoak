"use client";

// The thing that actually runs an import — mounted ONCE in the dashboard
// layout, not in the dialog that starts it.
//
// ★ WHY IT LIVES IN THE LAYOUT. The rows are posted to the server in chunks
// from the browser (see app/actions/import-export-actions.ts for why chunking
// is the design and not an optimisation). That loop belongs to whatever
// component owns it — so while it lived in the import dialog, the import could
// only survive as long as the dialog did, and the merchant had to sit and watch
// a modal. Moving it up to the layout means the loop keeps running across route
// changes, which is what makes "start it and get on with your day" possible at
// all: the dialog now hands the work over and closes, and the merchant is taken
// to the job's log.
//
// ⚠ WHAT THIS IS NOT. It is not a background job. The loop still runs in THIS
// tab, so closing the tab (or a hard reload) stops it — exactly as before. What
// is already imported stays imported, because every chunk commits on its own,
// and the job's log records where it got to. Making an import genuinely
// server-side needs the file uploaded somewhere and a worker to read it; that
// is a different feature, and this one had to stop being modal first.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Loader2, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import type { CsvRow } from "@/lib/csv/parse";
import type { ResourceId } from "@/lib/import-export/types";
import type { ImportOptions } from "@/lib/import-export/importers/types";
import { getResource } from "@/lib/import-export/resources";
import { IMPORT_CHUNK_ROWS } from "@/lib/import-export/limits";
import { finishImport, importChunk } from "@/app/actions/import-export-actions";

export interface ImportRun {
  jobId: string;
  resource: ResourceId;
  filename: string;
  header: string[];
  rows: CsvRow[];
  options: Partial<ImportOptions>;
}

interface RunState {
  jobId: string;
  resource: ResourceId;
  filename: string;
  total: number;
  done: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  phase: "running" | "finished" | "stopped";
  status?: string;
}

interface ImportRunnerApi {
  /** Hand a parsed file over. Returns once the job is accepted, not finished. */
  run: (input: ImportRun) => void;
  /** The import in flight, if there is one. */
  current: RunState | null;
  stop: () => void;
}

const Ctx = createContext<ImportRunnerApi | null>(null);

/** Throws rather than returning null: a caller that starts an import without
 *  the provider mounted would silently do nothing. */
export function useImportRunner(): ImportRunnerApi {
  const api = useContext(Ctx);
  if (!api)
    throw new Error("useImportRunner must be used inside ImportRunnerProvider");
  return api;
}

export function ImportRunnerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<RunState | null>(null);
  const cancelled = useRef(false);
  // The loop reads this to decide whether to keep going; state would be a stale
  // closure inside the async while-loop.
  const running = useRef(false);

  // ★ GUARD THE TAB. Half an import is not a corrupt state — every chunk has
  // committed and the log says where it stopped — but it IS a surprise, and the
  // merchant is the only one who can decide to accept it.
  useEffect(() => {
    if (state?.phase !== "running") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state?.phase]);

  const stop = useCallback(() => {
    cancelled.current = true;
    toast.info("Stopping after the current batch…");
  }, []);

  const run = useCallback(
    (input: ImportRun) => {
      if (running.current) {
        toast.error("An import is already running. Let it finish first.");
        return;
      }
      running.current = true;
      cancelled.current = false;

      setState({
        jobId: input.jobId,
        resource: input.resource,
        filename: input.filename,
        total: input.rows.length,
        done: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        phase: "running",
      });

      void (async () => {
        const totals = { created: 0, updated: 0, skipped: 0, failed: 0 };

        for (let i = 0; i < input.rows.length; i += IMPORT_CHUNK_ROWS) {
          if (cancelled.current) break;
          const slice = input.rows.slice(i, i + IMPORT_CHUNK_ROWS);

          const answer = await importChunk({
            jobId: input.jobId,
            resource: input.resource,
            header: input.header,
            rows: slice,
            options: input.options,
          });

          if (answer.data) {
            totals.created += answer.data.created;
            totals.updated += answer.data.updated;
            totals.skipped += answer.data.skipped;
            totals.failed += answer.data.failed;
          } else {
            // The chunk failed as a whole. Keep going: the rest of the file may
            // be perfectly good, and the job's log records what happened here.
            totals.failed += slice.length;
          }

          const done = i + slice.length;
          setState((s) => (s ? { ...s, ...totals, done } : s));
        }

        const finished = await finishImport(input.jobId, input.resource);
        const status = finished.data?.status;
        running.current = false;

        setState((s) =>
          s
            ? {
                ...s,
                ...totals,
                phase: cancelled.current ? "stopped" : "finished",
                status,
              }
            : s,
        );

        const resource = getResource(input.resource);
        const noun = resource?.noun ?? "rows";
        if (status === "failed") {
          toast.error("The import didn't work. Check the log for the details.");
        } else if (totals.failed > 0) {
          toast.warning(
            `Imported ${totals.created + totals.updated}, couldn't import ${totals.failed}.`,
          );
        } else {
          toast.success(
            `Imported ${(totals.created + totals.updated).toLocaleString("en-IN")} ${noun}.`,
          );
        }

        // The job page, the list pages the import touched, and the bell all read
        // server state that just changed.
        router.refresh();
      })();
    },
    [router],
  );

  return (
    <Ctx.Provider value={{ run, current: state, stop }}>
      {children}
      {state ? (
        <ImportChip
          state={state}
          onStop={stop}
          onDismiss={() => setState(null)}
        />
      ) : null}
    </Ctx.Provider>
  );
}

/**
 * The progress chip. Fixed to the viewport so it outlives the page beneath it —
 * the merchant may be anywhere in the dashboard while this runs.
 *
 * It does NOT auto-dismiss on success. An import is a bulk write to a
 * merchant's catalogue; "it finished, and here is what it did" is worth leaving
 * on screen until they have read it.
 */
function ImportChip({
  state,
  onStop,
  onDismiss,
}: {
  state: RunState;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const resource = getResource(state.resource);
  const pct =
    state.total > 0
      ? Math.min(100, Math.round((state.done / state.total) * 100))
      : 0;
  const done = state.phase !== "running";
  const bad = state.failed > 0 || state.status === "failed";

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[320px] rounded-xl border border-[var(--dash-border)] bg-[var(--dash-surface)] p-3 shadow-[0_12px_32px_-8px_rgba(16,24,40,0.24)]"
    >
      <div className="flex items-start gap-2">
        {!done ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--dash-accent)]" />
        ) : bad ? (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        )}

        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-[var(--dash-text)]">
            {!done
              ? `Importing ${resource?.noun ?? "rows"}…`
              : state.phase === "stopped"
                ? "Import stopped"
                : bad
                  ? "Imported with errors"
                  : "Import finished"}
          </div>
          <div className="truncate text-xs text-[var(--dash-text-3)]">
            {state.filename}
          </div>
        </div>

        {done ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="rounded p-0.5 text-[var(--dash-text-3)] hover:bg-[var(--dash-surface-2)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {!done ? (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--dash-surface-2)]">
            <div
              className="h-full rounded-full bg-[var(--dash-accent)] transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-xs text-[var(--dash-text-3)]">
            <span className="tabular-nums">
              {state.done.toLocaleString("en-IN")} of{" "}
              {state.total.toLocaleString("en-IN")}
            </span>
            <button
              type="button"
              onClick={onStop}
              className="hover:text-[var(--dash-text)] hover:underline"
            >
              Stop
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-[var(--dash-text-3)] tabular-nums">
            {state.created + state.updated} changed
            {state.failed > 0 ? ` · ${state.failed} failed` : ""}
          </span>
          <Link
            href={`/dashboard/logs/import-export/${state.jobId}`}
            className="text-[var(--dash-accent)] underline underline-offset-2"
          >
            {state.failed > 0 ? "See what failed" : "See the log"}
          </Link>
        </div>
      )}
    </div>
  );
}
