import "server-only";

// What an importer is handed and what it gives back.
//
// Every importer follows one contract: it NEVER throws, it reports one outcome
// per source row, and a failure on row 12 says nothing about row 13. That
// row-level atomicity is the whole design — see the header of
// supabase/import_export_01_jobs.sql for why file-level would be worse.

import type { UserIdentity } from "@/lib/db/client";
import type { RowIssue, RowOutcome } from "../types";

export interface ImportOptions {
  /**
   * Create rows the file names but the store doesn't have.
   *
   * Both toggles default ON, but being able to turn CREATE off is the guard
   * against the worst realistic accident: a file keyed on the wrong column
   * matches nothing and silently creates a duplicate of the merchant's entire
   * catalogue. "Only update what I already have" makes that impossible.
   */
  create: boolean;
  /** Update rows that already exist. Off = leave existing rows alone. */
  update: boolean;
  /** Inventory only: which location's shelf the counts belong to. */
  locationId?: string | null;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  create: true,
  update: true,
};

export interface ImportContext {
  storeId: string;
  /** Already gated by the caller on the resource's own permission section. */
  admin: UserIdentity;
  options: ImportOptions;
}

export interface RowResult {
  /** Every file line that fed this record — a product may span several. */
  lines: number[];
  outcome: RowOutcome;
  issues: RowIssue[];
}

export function issue(
  line: number,
  column: string | null,
  code: string,
  message: string,
  severity: RowIssue["severity"] = "error",
  value?: string | null,
): RowIssue {
  return { line, column, code, message, severity, value: value ?? null };
}

/** A failure message that names the cause without leaking DB internals. */
export function failure(
  lines: number[],
  message: string,
  code = "write_failed",
): RowResult {
  return {
    lines,
    outcome: "failed",
    issues: [issue(lines[0] ?? 0, null, code, message)],
  };
}

/**
 * Take only the fields the file actually supplied.
 *
 * The rule the whole importer rests on: an ABSENT cell means "leave this
 * alone", not "set it to null". It is what makes a two-column file (Handle +
 * Selling Price) a safe way to change only prices, and it is why every update
 * is built from the present keys rather than from a full row.
 */
export function present<T extends Record<string, unknown>>(
  values: Record<string, unknown>,
  map: Record<string, (v: unknown) => unknown>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [field, transform] of Object.entries(map)) {
    if (values[field] === undefined) continue;
    out[field] = transform(values[field]);
  }
  return out as Partial<T>;
}
