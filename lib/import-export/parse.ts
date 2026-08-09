// CSV rows → typed records, with every problem attributed to a file line.
//
// Pure. The browser runs this to build the import preview and the server runs
// it again on the same bytes before writing anything — the preview is a
// courtesy, never the validation.

import type { CsvRow, ParsedCsv } from "@/lib/csv/parse";
import { coerceCell, normalizeHeader, truncate } from "./coerce";
import { getResource } from "./resources";
import type {
  ColumnDef,
  ParsedFile,
  ParsedRecord,
  ResourceDef,
  RowIssue,
} from "./types";

export interface HeaderMap {
  /** Column claiming each file position, or null when nothing claims it. */
  byIndex: (ColumnDef | null)[];
  unknownHeaders: string[];
  /** Canonical keys of the columns the file supplied. */
  presentColumns: string[];
  duplicateHeaders: string[];
}

/**
 * Match the file's headers onto the resource's columns.
 *
 * Case, spaces, underscores, hyphens and dots are all normalised away first
 * (`normalizeHeader`), so `Selling Price`, `selling_price` and `SELLING-PRICE`
 * are the same column with no alias entry. Aliases cover a genuinely different
 * WORD — Shopify's `Body (HTML)` for our `Description`.
 */
export function mapHeaders(
  resource: ResourceDef,
  header: readonly string[],
): HeaderMap {
  const lookup = new Map<string, ColumnDef>();
  for (const col of resource.columns) {
    lookup.set(normalizeHeader(col.key), col);
    for (const alias of col.aliases ?? []) {
      const norm = normalizeHeader(alias);
      // A canonical key always wins over another column's alias.
      if (!lookup.has(norm)) lookup.set(norm, col);
    }
  }

  const byIndex: (ColumnDef | null)[] = [];
  const unknownHeaders: string[] = [];
  const duplicateHeaders: string[] = [];
  const claimed = new Set<string>();

  for (const raw of header) {
    const col = lookup.get(normalizeHeader(raw));
    if (!col) {
      byIndex.push(null);
      if (raw.trim()) unknownHeaders.push(raw.trim());
      continue;
    }
    if (claimed.has(col.key)) {
      // Two columns feeding one field: keep the FIRST. Letting the last win
      // means an appended blank column silently erases a populated one.
      byIndex.push(null);
      duplicateHeaders.push(raw.trim());
      continue;
    }
    claimed.add(col.key);
    byIndex.push(col);
  }

  return {
    byIndex,
    unknownHeaders,
    duplicateHeaders,
    presentColumns: [...claimed],
  };
}

function issue(
  line: number,
  column: string | null,
  code: string,
  message: string,
  severity: RowIssue["severity"],
  value?: string | null,
): RowIssue {
  return { line, column, code, message, severity, value: value ?? null };
}

/** Coerce one CSV row against the header map. */
export function parseRow(
  row: CsvRow,
  map: HeaderMap,
  resource: ResourceDef,
): ParsedRecord {
  const values: Record<string, unknown> = {};
  const issues: RowIssue[] = [];

  for (let i = 0; i < map.byIndex.length; i++) {
    const col = map.byIndex[i];
    if (!col) continue;
    // A short row simply has no value for the later columns, which is not the
    // same as a blank one — but both mean "don't change this", so they behave
    // identically and only the raggedness itself is worth reporting.
    const raw = row.cells[i] ?? "";

    // Read-only columns are parsed for nothing: an export round trip carries
    // them, and reading them would let a hand-edited SKU reach a write.
    if (col.readOnly) continue;

    const result = coerceCell(raw, col);
    if (!result.ok) {
      issues.push(
        issue(row.line, col.key, result.code, result.message, "error", raw),
      );
      continue;
    }
    if (result.value !== undefined) values[col.field] = result.value;
    if (result.note) {
      issues.push(
        issue(
          row.line,
          col.key,
          result.note.code,
          result.note.message,
          "warning",
          raw,
        ),
      );
    }
  }

  // A required column present in the file but blank on this row is caught by
  // coerceCell. A required column absent from the file entirely is a FILE
  // issue, raised once in parseFile rather than on all 4,000 rows.
  void resource;

  return {
    line: row.line,
    values,
    issues,
    ok: !issues.some((i) => i.severity === "error"),
  };
}

/**
 * Parse a whole file for a resource.
 *
 * File-level problems (a missing match column, an empty file) return early
 * with `records: []`: there is no value in reporting 4,000 identical row
 * errors when one sentence about the header explains all of them.
 */
export function parseFile(
  resourceId: string,
  csv: ParsedCsv,
): ParsedFile | { error: string } {
  const resource = getResource(resourceId);
  if (!resource) return { error: `Unknown resource "${resourceId}".` };
  if (!resource.canImport)
    return { error: `${resource.label} can be exported but not imported.` };

  const fileIssues: RowIssue[] = [];

  if (csv.header.length === 0)
    return {
      error:
        "That file has no header row, so there's nothing to match columns against.",
    };

  const map = mapHeaders(resource, csv.header);

  // The match column decides create-vs-update for every row. Without it the
  // import cannot tell a correction from a duplicate, so it stops here rather
  // than creating a second copy of the merchant's whole catalogue.
  const missingMatch = resource.matchOn.filter(
    (key) => !map.presentColumns.includes(key),
  );
  if (
    resource.matchOn.length > 0 &&
    missingMatch.length === resource.matchOn.length
  ) {
    return {
      error: `This file needs a "${resource.matchOn[0]}" column — it's how each row is matched to an existing ${resource.label.toLowerCase().replace(/s$/, "")}. Found: ${csv.header.filter(Boolean).join(", ") || "nothing"}.`,
    };
  }

  const requiredMissing = resource.columns.filter(
    (c) => c.required && !map.presentColumns.includes(c.key),
  );
  for (const col of requiredMissing) {
    fileIssues.push(
      issue(
        0,
        col.key,
        "missing_column",
        `The "${col.key}" column is required and isn't in this file.`,
        "error",
      ),
    );
  }
  if (requiredMissing.length > 0) {
    return {
      resource: resource.id,
      records: [],
      fileIssues,
      unknownHeaders: map.unknownHeaders,
      presentColumns: map.presentColumns,
      truncated: csv.truncated,
    };
  }

  for (const header of map.unknownHeaders) {
    fileIssues.push(
      issue(
        0,
        header,
        "unknown_column",
        `The "${truncate(header, 60)}" column isn't one we recognise, so it was ignored.`,
        "warning",
      ),
    );
  }
  for (const header of map.duplicateHeaders) {
    fileIssues.push(
      issue(
        0,
        header,
        "duplicate_column",
        `"${truncate(header, 60)}" appears more than once. Only the first was used.`,
        "warning",
      ),
    );
  }
  for (const line of csv.raggedLines) {
    fileIssues.push(
      issue(
        line,
        null,
        "ragged_row",
        "This row has a different number of cells than the header. Missing cells were treated as blank.",
        "warning",
      ),
    );
  }
  if (csv.truncated) {
    fileIssues.push(
      issue(
        0,
        null,
        "truncated",
        "The file was longer than the row limit, so the rest was not read.",
        "warning",
      ),
    );
  }

  const records = csv.rows.map((row) => parseRow(row, map, resource));

  if (records.length === 0) {
    fileIssues.push(
      issue(0, null, "empty", "That file has a header but no rows.", "error"),
    );
  }

  return {
    resource: resource.id,
    records,
    fileIssues,
    unknownHeaders: map.unknownHeaders,
    presentColumns: map.presentColumns,
    truncated: csv.truncated,
  };
}

// ---------------------------------------------------------------------------
// Products: folding rows back into products
// ---------------------------------------------------------------------------

export interface VariantDraft {
  line: number;
  name: string;
  values: Record<string, unknown>;
}

export interface ProductDraft {
  handle: string;
  /** The handle's first line — where a product-level error is reported. */
  line: number;
  /** Every line that fed this product, so one failure can mark them all. */
  lines: number[];
  values: Record<string, unknown>;
  variants: VariantDraft[];
}

const VARIANT_FIELDS = new Set([
  "variantName",
  "variantBasePrice",
  "variantSellingPrice",
  "variantSpecialPrice",
  "variantStock",
  "variantBarcode",
  "variantImageUrl",
]);

/**
 * Fold Shopify-shaped product rows into products.
 *
 * Rows sharing a Handle are one product: the first occurrence supplies the
 * product fields and every row with a Variant Name adds a variant. Later rows
 * may repeat product fields (a spreadsheet fill-down does this constantly) —
 * the FIRST defined value wins, so a blank cell on a variant row never erases
 * something the first row set. That is the same "absent means leave alone"
 * rule the importer applies against the database.
 *
 * Handles are compared case-insensitively: `Milk` and `milk` are one slug in
 * the database, so treating them as two products would fail on the unique
 * index after creating one of them.
 */
export function groupProductRows(
  records: readonly ParsedRecord[],
): ProductDraft[] {
  const byHandle = new Map<string, ProductDraft>();

  for (const record of records) {
    if (!record.ok) continue;
    const handle = String(record.values.handle ?? "").trim();
    if (!handle) continue;
    const key = handle.toLowerCase();

    let draft = byHandle.get(key);
    if (!draft) {
      draft = {
        handle,
        line: record.line,
        lines: [],
        values: {},
        variants: [],
      };
      byHandle.set(key, draft);
    }
    draft.lines.push(record.line);

    for (const [field, value] of Object.entries(record.values)) {
      if (VARIANT_FIELDS.has(field)) continue;
      if (draft.values[field] === undefined) draft.values[field] = value;
    }

    const variantName = record.values.variantName;
    if (typeof variantName === "string" && variantName.trim()) {
      const values: Record<string, unknown> = {};
      for (const field of VARIANT_FIELDS) {
        if (field === "variantName") continue;
        if (record.values[field] !== undefined)
          values[field] = record.values[field];
      }
      draft.variants.push({
        line: record.line,
        name: variantName.trim(),
        values,
      });
    }
  }

  return [...byHandle.values()];
}

/** Errors that only show up once the whole file is in view. */
export function crossRowIssues(
  resource: ResourceDef,
  records: readonly ParsedRecord[],
): RowIssue[] {
  const issues: RowIssue[] = [];
  const matchKey = resource.matchOn[0];
  if (!matchKey) return issues;

  // Products deliberately EXPECT repeats — that is how variants are expressed.
  if (resource.id === "products") return issues;

  const col = resource.columns.find((c) => c.key === matchKey);
  if (!col) return issues;

  const seen = new Map<string, number>();
  for (const record of records) {
    if (!record.ok) continue;
    const raw = record.values[col.field];
    if (typeof raw !== "string") continue;
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const first = seen.get(key);
    if (first !== undefined) {
      // Not an error: the last row simply wins, exactly as it would if the
      // merchant ran two imports. But it is nearly always a mistake, and
      // silently applying only one of two conflicting rows is how a price
      // change appears not to have worked.
      issues.push(
        issue(
          record.line,
          matchKey,
          "duplicate_row",
          `"${truncate(raw, 60)}" also appears on line ${first}. The later row wins.`,
          "warning",
          raw,
        ),
      );
      continue;
    }
    seen.set(key, record.line);
  }
  return issues;
}
