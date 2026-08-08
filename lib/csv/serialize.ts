// RFC 4180 CSV writer.
//
// Pure, and used by every export. Two rules here are load-bearing rather than
// cosmetic — see `guardFormula` and the BOM note below.

export interface SerializeOptions {
  delimiter?: string;
  eol?: string;
  /**
   * Prepend a UTF-8 BOM. ON by default for downloads, because Excel on Windows
   * reads a BOM-less UTF-8 file as the system codepage: a store called `Café`
   * exports fine and opens as `CafÃ©`, and the merchant reimports the mojibake.
   * Our own parser strips the BOM, so a round trip is unaffected.
   */
  bom?: boolean;
}

/** Values Excel/Sheets/LibreOffice would evaluate as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
/** A plain number, including a leading minus — see guardFormula. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Neutralise CSV formula injection.
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula when
 * the file is opened — `=HYPERLINK(...)` exfiltrates whatever it is pointed at,
 * and worse is available. The export is built from merchant- and
 * customer-supplied text (product names, order notes, addresses), so the
 * attacker does not need an account here: leaving a review or placing an order
 * with a crafted name is enough to reach the spreadsheet of a merchant who
 * exports their data. Prefixing an apostrophe makes the cell literal text.
 *
 * ★ A PLAIN NUMBER IS LEFT ALONE. The naive rule mangles every negative
 * quantity and price in the file — `-5` exports as `'-5`, which reimports as
 * text and fails validation — so the guard would break the round trip it
 * exists inside. A number cannot carry a formula payload, so exempting it
 * costs nothing.
 */
export function guardFormula(value: string): string {
  if (!FORMULA_PREFIX.test(value)) return value;
  if (PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

function encodeCell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return "";

  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "boolean") text = value ? "TRUE" : "FALSE";
  else text = String(value);

  text = guardFormula(text);

  const mustQuote =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r") ||
    text !== text.trim(); // preserve significant leading/trailing space

  if (!mustQuote) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Encode one row. Exported so a streaming export can emit row by row without
 *  ever holding the whole file in memory. */
export function serializeCsvRow(
  cells: readonly unknown[],
  options: SerializeOptions = {},
): string {
  const delimiter = options.delimiter ?? ",";
  const eol = options.eol ?? "\r\n"; // RFC 4180; Excel is happiest with CRLF
  return cells.map((c) => encodeCell(c, delimiter)).join(delimiter) + eol;
}

/** Encode a whole table (header + rows). For anything unbounded, stream with
 *  `serializeCsvRow` instead. */
export function serializeCsv(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: SerializeOptions = {},
): string {
  const bom = options.bom ?? true;
  let out = bom ? "﻿" : "";
  out += serializeCsvRow(header, options);
  for (const row of rows) out += serializeCsvRow(row, options);
  return out;
}
