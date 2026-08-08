"use client";

// The import dialog — pick a file, see what will happen, then commit.
//
// ★ THE FILE NEVER LEAVES THE BROWSER IN ONE PIECE. It is parsed and validated
// here with the same pure modules the server uses (lib/csv, lib/import-export),
// so the preview is instant and costs nothing, and then the ROWS are posted in
// chunks. See the header of app/actions/import-export-actions.ts for why
// chunking is the design rather than an optimisation.
//
// The preview is a courtesy, not a gate: the server re-parses and re-validates
// every chunk against the same registry before writing anything.

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { parseCsv, type CsvRow } from "@/lib/csv/parse";
import { crossRowIssues, parseFile } from "@/lib/import-export/parse";
import { getResource } from "@/lib/import-export/resources";
import { slugify } from "@/lib/slug";
import type {
  ParsedFile,
  ResourceId,
  RowIssue,
} from "@/lib/import-export/types";
import {
  finishImport,
  importChunk,
  previewImport,
  startImport,
} from "@/app/actions/import-export-actions";
import {
  IMPORT_CHUNK_ROWS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
} from "@/lib/import-export/limits";

type Phase = "pick" | "review" | "running" | "done";

interface Preview {
  parsed: ParsedFile;
  /** The RAW header and rows. What gets posted to the server, so it can run the
   *  identical parse itself rather than trusting the typed values we derived. */
  header: string[];
  rows: CsvRow[];
  crossIssues: RowIssue[];
  existing: Set<string>;
}

export interface ImportDialogProps {
  resource: ResourceId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Locations offered for a stock import. Omitted = the store's default. */
  locations?: { id: string; name: string }[];
}

export function ImportDialog({
  resource: resourceId,
  open,
  onOpenChange,
  locations,
}: ImportDialogProps) {
  const router = useRouter();
  const resource = getResource(resourceId);
  const inputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);

  const [create, setCreate] = useState(true);
  const [update, setUpdate] = useState(true);
  const [locationId, setLocationId] = useState<string>("");

  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{
    jobId: string;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  } | null>(null);

  const cancelled = useRef(false);

  const reset = useCallback(() => {
    setPhase("pick");
    setFile(null);
    setFileError(null);
    setPreview(null);
    setProgress(0);
    setResult(null);
    setCreate(true);
    setUpdate(true);
    cancelled.current = false;
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const close = (next: boolean) => {
    // Leaving mid-import would orphan the job with no way back to it, and the
    // rows already written are not undone — so the dialog holds.
    if (!next && phase === "running") return;
    if (!next) reset();
    onOpenChange(next);
  };

  const matchValueOf = useCallback(
    (values: Record<string, unknown>): string => {
      if (!resource) return "";
      const key = resource.matchOn[0];
      const col = resource.columns.find((c) => c.key === key);
      if (!col) return "";
      const raw = values[col.field];
      return typeof raw === "string" ? raw.trim() : "";
    },
    [resource],
  );

  async function onPick(picked: File | null) {
    if (!picked || !resource) return;
    setFileError(null);
    setPreview(null);

    if (picked.size > MAX_IMPORT_FILE_BYTES) {
      setFileError(
        `That file is ${(picked.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB — split it into a few smaller files.`,
      );
      return;
    }

    setFile(picked);
    setReading(true);
    try {
      const text = await picked.text();
      const csv = parseCsv(text, { maxRows: MAX_IMPORT_ROWS });
      const parsed = parseFile(resource.id, csv);

      if ("error" in parsed) {
        setFileError(parsed.error);
        setReading(false);
        return;
      }

      const crossIssues = crossRowIssues(resource, parsed.records);

      // Ask the server which of these it already has — the only thing the
      // browser genuinely cannot work out, and the number that decides whether
      // a merchant clicks Import.
      const matchValues = [
        ...new Set(
          parsed.records
            .filter((r) => r.ok)
            .map((r) => matchValueOf(r.values))
            .filter(Boolean),
        ),
      ];

      let existing = new Set<string>();
      const answer = await previewImport(resource.id, matchValues);
      if (answer.data) existing = new Set(answer.data.existing);

      setPreview({
        parsed,
        header: csv.header,
        rows: csv.rows,
        crossIssues,
        existing,
      });
      setPhase("review");
    } catch {
      setFileError("Couldn't read that file. Is it a CSV?");
    } finally {
      setReading(false);
    }
  }

  const counts = useMemo(() => {
    if (!preview || !resource) return null;
    const good = preview.parsed.records.filter((r) => r.ok);
    const bad = preview.parsed.records.length - good.length;

    // Products are grouped by handle, so "rows" and "products" differ — saying
    // "412 rows" about a file that will produce 180 products is confusing at
    // exactly the moment precision matters.
    const keys = new Set(
      good.map((r) => matchValueOf(r.values)).filter(Boolean),
    );
    let creating = 0;
    let updating = 0;
    for (const key of keys) {
      const normalised =
        resource.id === "coupons" ? key.toUpperCase() : slugify(key);
      if (preview.existing.has(normalised)) updating++;
      else creating++;
    }

    const warnings = [
      ...preview.parsed.fileIssues.filter((i) => i.severity === "warning"),
      ...preview.crossIssues,
    ];
    const errors = preview.parsed.records.flatMap((r) =>
      r.issues.filter((i) => i.severity === "error"),
    );

    return {
      rows: preview.parsed.records.length,
      unique: keys.size,
      creating,
      updating,
      bad,
      warnings,
      errors,
    };
  }, [preview, resource, matchValueOf]);

  async function run() {
    if (!preview || !resource || !file) return;
    cancelled.current = false;
    setPhase("running");
    setProgress(0);

    const options = {
      create,
      update,
      locationId: locationId || null,
    };

    const started = await startImport({
      resource: resource.id,
      filename: file.name,
      totalRows: preview.rows.length,
      header: preview.header,
      options,
    });

    if (!started.data) {
      toast.error(started.error ?? "Couldn't start the import.");
      setPhase("review");
      return;
    }

    const jobId = started.data.jobId;
    // The RAW rows, exactly as parsed from the file. The server re-parses them
    // against the registry — sending our typed values instead would make the
    // browser the validator.
    const { header, rows } = preview;

    const totals = { created: 0, updated: 0, skipped: 0, failed: 0 };

    for (let i = 0; i < rows.length; i += IMPORT_CHUNK_ROWS) {
      if (cancelled.current) break;
      const slice = rows.slice(i, i + IMPORT_CHUNK_ROWS);

      const answer = await importChunk({
        jobId,
        resource: resource.id,
        header,
        rows: slice,
        options,
      });

      if (answer.data) {
        totals.created += answer.data.created;
        totals.updated += answer.data.updated;
        totals.skipped += answer.data.skipped;
        totals.failed += answer.data.failed;
      } else {
        // The chunk failed as a whole. Keep going: the rest of the file may be
        // perfectly good, and the job's log records what happened here.
        totals.failed += slice.length;
      }

      setProgress(
        Math.min(100, Math.round(((i + slice.length) / rows.length) * 100)),
      );
    }

    const finished = await finishImport(jobId, resource.id);
    setResult({ jobId, ...totals });
    setPhase("done");

    if (finished.data?.status === "failed") {
      toast.error("The import didn't work. Check the log for the details.");
    } else if (totals.failed > 0) {
      toast.warning(
        `Imported ${totals.created + totals.updated}, couldn't import ${totals.failed}.`,
      );
    } else {
      toast.success(
        `Imported ${totals.created + totals.updated} ${resource.noun}.`,
      );
    }
    router.refresh();
  }

  if (!resource) return null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] gap-0 overflow-y-auto sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Import {resource.label.toLowerCase()}</DialogTitle>
          <DialogDescription>{resource.description}</DialogDescription>
        </DialogHeader>

        {phase === "pick" ? (
          <div className="flex flex-col gap-4 py-2">
            <label
              className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--dash-border)] bg-[var(--dash-surface-2)] px-4 py-8 text-center transition-colors hover:border-[var(--dash-accent)]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void onPick(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="sr-only"
                onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
              />
              {reading ? (
                <Loader2 className="h-6 w-6 animate-spin text-[var(--dash-text-3)]" />
              ) : (
                <FileUp className="h-6 w-6 text-[var(--dash-text-3)]" />
              )}
              <span className="text-sm font-medium text-[var(--dash-text)]">
                {reading
                  ? "Reading your file…"
                  : "Choose a CSV file, or drop one here"}
              </span>
              <span className="text-xs text-[var(--dash-text-3)]">
                Up to {MAX_IMPORT_ROWS.toLocaleString("en-IN")} rows
              </span>
            </label>

            {fileError ? (
              <p className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{fileError}</span>
              </p>
            ) : null}

            <div className="flex items-center justify-between rounded-md border border-[var(--dash-border)] px-3 py-2">
              <span className="text-[13px] text-[var(--dash-text-2)]">
                Not sure about the columns? Start from a template.
              </span>
              <a
                href={`/api/dashboard/export?resource=${resource.id}&template=1`}
                className="dash-btn dash-btn-ghost dash-btn-sm"
                download
              >
                <Download className="h-3.5 w-3.5" />
                Template
              </a>
            </div>
          </div>
        ) : null}

        {phase === "review" && counts ? (
          <div className="flex flex-col gap-4 py-2">
            <div className="flex items-center justify-between rounded-md bg-[var(--dash-surface-2)] px-3 py-2 text-[13px]">
              <span className="truncate font-medium">{file?.name}</span>
              <button
                type="button"
                className="dash-btn dash-btn-ghost dash-btn-sm"
                onClick={reset}
              >
                <X className="h-3.5 w-3.5" />
                Change
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Stat label="To create" value={counts.creating} tone="accent" />
              <Stat label="To update" value={counts.updating} />
              <Stat
                label="Can't import"
                value={counts.bad}
                tone={counts.bad > 0 ? "danger" : undefined}
              />
            </div>

            <fieldset className="flex flex-col gap-2 rounded-md border border-[var(--dash-border)] px-3 py-3">
              <legend className="px-1 text-xs font-medium text-[var(--dash-text-3)]">
                What this import may do
              </legend>
              {resource.id !== "inventory" ? (
                <Toggle
                  checked={create}
                  onChange={setCreate}
                  label={`Create ${resource.noun} that aren't here yet`}
                  hint={
                    create
                      ? undefined
                      : "Only existing rows will be changed. Nothing new will be added."
                  }
                />
              ) : null}
              <Toggle
                checked={update}
                onChange={setUpdate}
                label={`Update ${resource.noun} that already exist`}
                hint={
                  update
                    ? undefined
                    : "Existing rows will be left exactly as they are."
                }
              />
              {resource.id === "inventory" && locations?.length ? (
                <label className="flex items-center justify-between gap-3 pt-1 text-[13px]">
                  <span>Location for rows that don&apos;t name one</span>
                  <select
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                    className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-2 py-1 text-[13px]"
                  >
                    <option value="">Default location</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </fieldset>

            <IssueList
              title={`${counts.errors.length} row${counts.errors.length === 1 ? "" : "s"} will be skipped`}
              issues={counts.errors}
              tone="danger"
            />
            <IssueList
              title={`${counts.warnings.length} thing${counts.warnings.length === 1 ? "" : "s"} to know`}
              issues={counts.warnings}
              tone="warning"
            />
          </div>
        ) : null}

        {phase === "running" ? (
          <div className="flex flex-col gap-3 py-6">
            <div className="flex items-center gap-2 text-[13px] text-[var(--dash-text-2)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Importing… {progress}%
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[var(--dash-surface-2)]">
              <div
                className="h-full rounded-full bg-[var(--dash-accent)] transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-[var(--dash-text-3)]">
              Keep this tab open. Rows already imported are saved as they go —
              if this stops, nothing that already worked is lost.
            </p>
          </div>
        ) : null}

        {phase === "done" && result ? (
          <div className="flex flex-col gap-3 py-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              {result.failed > 0 ? (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              )}
              Import finished
            </div>
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Created" value={result.created} tone="accent" />
              <Stat label="Updated" value={result.updated} />
              <Stat label="Skipped" value={result.skipped} />
              <Stat
                label="Failed"
                value={result.failed}
                tone={result.failed > 0 ? "danger" : undefined}
              />
            </div>
            <Link
              href={`/dashboard/activity/import-export/${result.jobId}`}
              className="text-[13px] text-[var(--dash-accent)] underline underline-offset-2"
              onClick={() => close(false)}
            >
              {result.failed > 0
                ? "See what went wrong, row by row"
                : "See the full log for this import"}
            </Link>
          </div>
        ) : null}

        <DialogFooter>
          {phase === "review" ? (
            <>
              <button
                type="button"
                className="dash-btn dash-btn-ghost"
                onClick={() => close(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dash-btn dash-btn-primary"
                disabled={!counts || counts.rows === counts.bad}
                onClick={() => void run()}
              >
                <Upload className="h-4 w-4" />
                Import {counts?.unique ?? 0} {resource.noun}
              </button>
            </>
          ) : null}
          {phase === "running" ? (
            <button
              type="button"
              className="dash-btn dash-btn-ghost"
              onClick={() => {
                cancelled.current = true;
                toast.info("Stopping after the current batch…");
              }}
            >
              Stop
            </button>
          ) : null}
          {phase === "done" ? (
            <button
              type="button"
              className="dash-btn dash-btn-primary"
              onClick={() => close(false)}
            >
              Done
            </button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "accent" | "danger";
}) {
  const color =
    tone === "danger"
      ? "text-red-600 dark:text-red-400"
      : tone === "accent"
        ? "text-[var(--dash-accent)]"
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

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[13px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        {label}
        {hint ? (
          <span className="block text-xs text-[var(--dash-text-3)]">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** The first few problems, inline. The rest live in the job's log — a dialog
 *  listing 900 errors is one nobody reads. */
function IssueList({
  title,
  issues,
  tone,
}: {
  title: string;
  issues: RowIssue[];
  tone: "danger" | "warning";
}) {
  if (issues.length === 0) return null;
  const shown = issues.slice(0, 5);
  const color =
    tone === "danger"
      ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
      : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300";

  return (
    <div className={`rounded-md border px-3 py-2 text-[13px] ${color}`}>
      <div className="font-medium">{title}</div>
      <ul className="mt-1 flex flex-col gap-1">
        {shown.map((issue, i) => (
          <li key={`${issue.line}-${issue.code}-${i}`} className="text-xs">
            {issue.line > 0 ? <strong>Row {issue.line}: </strong> : null}
            {issue.message}
          </li>
        ))}
      </ul>
      {issues.length > shown.length ? (
        <div className="mt-1 text-xs opacity-80">
          …and {issues.length - shown.length} more. The full list is in the log
          once you import.
        </div>
      ) : null}
    </div>
  );
}
