// RFC 4180 CSV reader.
//
// Pure and dependency-free, so the browser can parse the merchant's file before
// a single byte is sent to the server (which is what makes the import preview
// instant) and the server can re-parse the same bytes with identical results.
// TWO parsers would be the bug: the preview would promise one thing and the
// import would do another.
//
// It is deliberately LENIENT about the things real spreadsheet exports get
// wrong, and strict about nothing. A merchant's file comes out of Excel,
// Google Sheets, Shopify, WooCommerce or a hand-edited text editor, and
// refusing to read it is not a defensible outcome when the shape is obvious.

/** Delimiters worth guessing between. Order is the tie-break order. */
const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

export interface CsvRow {
  /**
   * 1-based line number in the ORIGINAL file, so an error points at the line
   * the merchant sees in their spreadsheet.
   *
   * NOT the row index: blank lines are skipped and a quoted field may contain
   * newlines, so the two diverge the moment a file is anything but trivial —
   * and "row 40 is broken" pointing at line 47 is worse than no number at all.
   */
  line: number;
  cells: string[];
}

export interface ParsedCsv {
  /** Header cells, trimmed. Empty when the file had no content. */
  header: string[];
  rows: CsvRow[];
  /** The delimiter actually used, whether sniffed or supplied. */
  delimiter: string;
  /** Lines whose cell count did not match the header's. */
  raggedLines: number[];
  /** True when `maxRows` stopped the parse before the end of the file. */
  truncated: boolean;
}

export interface ParseOptions {
  /** Force a delimiter instead of sniffing one. */
  delimiter?: string;
  /**
   * Cap on DATA rows (the header is never counted). Parsing stops once it is
   * reached and `truncated` is set — an unbounded parse of an accidentally
   * uploaded 2 GB file would take the tab down before any validation runs.
   */
  maxRows?: number;
}

/**
 * Guess the delimiter from the first logical line.
 *
 * Quote-aware, which is the whole reason this isn't a `split(",").length`
 * count: a perfectly ordinary header cell like `"Name, legal"` would otherwise
 * vote for comma in a semicolon file and every subsequent row would be read as
 * one giant cell. Semicolon files are not exotic — Excel writes them by default
 * in every locale that uses a comma as the decimal separator.
 */
export function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>(
    CANDIDATE_DELIMITERS.map((d) => [d as string, 0]),
  );
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"')
          i++; // escaped quote — still inside
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") break; // end of the first logical line
    const seen = counts.get(ch);
    if (seen !== undefined) counts.set(ch, seen + 1);
  }

  let best = ",";
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** Strip a UTF-8 BOM. Excel writes one, and it would otherwise become part of
 *  the first header name — so `Handle` arrives as `﻿Handle` and matches
 *  nothing, which reads to the merchant as "it ignored my first column". */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into a header plus rows.
 *
 * Handles quoted fields containing the delimiter, newlines and doubled quotes;
 * CRLF, LF and bare-CR line endings; a trailing newline; and blank lines
 * (dropped — Excel litters them at the end of a file, and an "empty row"
 * error for each would bury the real ones).
 *
 * A stray quote INSIDE a quoted field that isn't followed by a delimiter or a
 * newline is kept as a literal character rather than treated as an error. That
 * is malformed CSV, but it is what a hand-written 6" cable description
 * produces, and the intent is never in doubt.
 */
export function parseCsv(input: string, options: ParseOptions = {}): ParsedCsv {
  const text = stripBom(input);
  const delimiter = options.delimiter ?? sniffDelimiter(text);
  const maxRows = options.maxRows ?? Infinity;

  const rows: CsvRow[] = [];
  let header: string[] | null = null;
  const raggedLines: number[] = [];
  let truncated = false;

  let field = "";
  let cells: string[] = [];
  let inQuotes = false;
  let line = 1; // line the CURRENT record started on
  let physicalLine = 1; // line the cursor is on

  const pushField = () => {
    cells.push(field);
    field = "";
  };

  const pushRow = () => {
    pushField();
    // Drop a wholly empty record rather than reporting it. A single trailing
    // newline produces one of these in every well-formed file.
    const empty = cells.every((c) => c.trim() === "");
    if (!empty) {
      if (header === null) {
        header = cells.map((c) => c.trim());
      } else if (rows.length < maxRows) {
        if (cells.length !== header.length) raggedLines.push(line);
        rows.push({ line, cells });
      } else {
        truncated = true;
      }
    }
    cells = [];
    line = physicalLine;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          // Closing quote only if what follows ends the field. Anything else is
          // a literal quote in sloppy-but-obvious input (`6" cable`).
          const next = text[i + 1];
          if (
            next === undefined ||
            next === delimiter ||
            next === "\n" ||
            next === "\r"
          ) {
            inQuotes = false;
          } else {
            field += '"';
          }
        }
        continue;
      }
      if (ch === "\n") physicalLine++;
      field += ch;
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === "\r") {
      // CRLF and bare CR both end the record; only consume the LF if present.
      if (text[i + 1] === "\n") i++;
      physicalLine++;
      pushRow();
      if (truncated) break;
      continue;
    }
    if (ch === "\n") {
      physicalLine++;
      pushRow();
      if (truncated) break;
      continue;
    }
    field += ch;
  }

  // Final record when the file does not end in a newline.
  if (!truncated && (field !== "" || cells.length > 0 || inQuotes)) pushRow();

  return {
    header: header ?? [],
    rows,
    delimiter,
    raggedLines,
    truncated,
  };
}
