// Shared types for CSV import/export. Pure — no server imports — so the
// registry, the browser-side preview, the server actions and the tests all
// read the same definitions.

/** Everything that can be moved in or out as CSV. */
export type ResourceId =
  | "products"
  | "categories"
  | "inventory"
  | "orders"
  | "coupons";

export const RESOURCE_IDS: readonly ResourceId[] = [
  "products",
  "categories",
  "inventory",
  "orders",
  "coupons",
];

export type JobKind = "import" | "export";

/**
 * A job's lifecycle.
 *
 * `partial` is a first-class outcome, not a failure: a 500-row import where 3
 * rows are broken must import the other 497 and say so. Collapsing it into
 * "failed" is what makes a merchant re-upload the whole file and create 497
 * duplicates.
 */
export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type CellType =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "enum"
  | "list"
  | "url"
  | "date";

export interface ColumnDef {
  /** Canonical CSV header — what an export writes and a template offers. */
  key: string;
  /**
   * Other headers accepted on import: Shopify's and WooCommerce's names for
   * the same field, plus our own older ones. Matching is already
   * case/space/underscore-insensitive (see `normalizeHeader`), so an alias is
   * only needed for a genuinely DIFFERENT word.
   */
  aliases?: readonly string[];
  type: CellType;
  /** The field on the parsed record. Defaults to a camelCase of `key`. */
  field: string;
  required?: boolean;
  /** For `enum`. Compared case-insensitively. */
  enumValues?: readonly string[];
  /** Accepted spellings mapped onto an enum value (`live` → `published`). */
  enumAliases?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  maxLength?: number;
  /**
   * Written by the export, IGNORED by the import. For values the database
   * owns: a system SKU, a used-coupon count, a computed total. Round-tripping
   * an export must not let a merchant edit one of these by hand — see the
   * `sku` note in CODEBASE §14.
   */
  readOnly?: boolean;
  /** Shown in the column reference and the downloadable template. */
  help?: string;
  /** Sample value for the template file. */
  example?: string;
}

export interface ResourceDef {
  id: ResourceId;
  label: string;
  /** Plural noun used in copy: "12 products imported". */
  noun: string;
  description: string;
  /**
   * The dashboard permission section that owns this data. Import requires
   * `manage` on it and export requires `view` — there is deliberately NO
   * import/export permission of its own, which would be a way to grant someone
   * write access to products without granting them Products.
   */
  section: string;
  canImport: boolean;
  canExport: boolean;
  /**
   * Columns tried in order to find an existing row. The first one PRESENT in
   * the file wins, and it decides create-vs-update for every row.
   */
  matchOn: readonly string[];
  columns: readonly ColumnDef[];
  /** Extra sections whose `manage` is also required (inventory needs both). */
  alsoRequires?: readonly string[];
}

export type IssueSeverity = "error" | "warning";

/**
 * One problem with one row.
 *
 * `error` skips the row; `warning` imports it and says what was assumed. The
 * distinction is the whole point of the log: a merchant needs to know their
 * 3 failures apart from their 200 "price rounded to 2dp" notes.
 */
export interface RowIssue {
  /** 1-based line in the ORIGINAL file — what their spreadsheet shows. */
  line: number;
  /** The header involved, or null for a whole-row problem. */
  column: string | null;
  code: string;
  message: string;
  /** The offending cell, truncated. Null when the problem is the row itself. */
  value?: string | null;
  severity: IssueSeverity;
}

/** A row after coercion: typed values plus whatever went wrong reading it. */
export interface ParsedRecord {
  line: number;
  values: Record<string, unknown>;
  issues: RowIssue[];
  /** True when no `error`-severity issue was found. */
  ok: boolean;
}

export interface ParsedFile {
  resource: ResourceId;
  records: ParsedRecord[];
  /** Problems with the file as a whole (missing column, unknown header…). */
  fileIssues: RowIssue[];
  /** Headers present in the file that no column claimed. */
  unknownHeaders: string[];
  /** Canonical column keys the file actually supplied. */
  presentColumns: string[];
  truncated: boolean;
}

/** What an import did, per row. Aggregated into the job counters. */
export type RowOutcome = "created" | "updated" | "skipped" | "failed";

export interface ImportCounts {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export function emptyCounts(): ImportCounts {
  return { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
}
