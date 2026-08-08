// Turning one CSV cell into one typed value.
//
// Pure and total: every function returns either a value or a reason, never
// throws, and never guesses in a way it cannot explain. The messages are read
// by a merchant looking at their own spreadsheet, so they name the cell's
// content and what was expected — "Row 14, Price: '₹1.2.3' isn't a number" is
// actionable; "invalid input" is not.

import type { ColumnDef } from "./types";

export interface CoerceOk {
  ok: true;
  value: unknown;
  /** Set when the value was accepted but changed — surfaces as a warning. */
  note?: { code: string; message: string };
}
export interface CoerceErr {
  ok: false;
  code: string;
  message: string;
}
export type CoerceResult = CoerceOk | CoerceErr;

const ok = (value: unknown, note?: CoerceOk["note"]): CoerceOk => ({
  ok: true,
  value,
  note,
});
const err = (code: string, message: string): CoerceErr => ({
  ok: false,
  code,
  message,
});

/**
 * Normalise a header for matching: case, spaces, underscores and surrounding
 * punctuation all collapse. So `Selling Price`, `selling_price`, `SELLING
 * PRICE` and `Selling price` are one column, and only a genuinely different
 * WORD needs an alias entry.
 */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.]+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Currency symbols and separators a merchant leaves in a price cell. */
const NUMERIC_NOISE = /[₹$€£¥\s,'’]/g;

function toNumber(raw: string): number | null {
  const cleaned = raw.replace(NUMERIC_NOISE, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
  // Reject anything Number() would be too generous about: "1e5", "0x10",
  // "Infinity" are not what a merchant meant to type in a price cell.
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const TRUE_WORDS = new Set([
  "true",
  "yes",
  "y",
  "1",
  "on",
  "active",
  "enabled",
  "published",
]);
const FALSE_WORDS = new Set([
  "false",
  "no",
  "n",
  "0",
  "off",
  "inactive",
  "disabled",
  "draft",
  "hidden",
]);

/**
 * ISO 8601 ONLY, deliberately.
 *
 * `05/08/2026` is 5 August to the merchant typing it and 8 May to V8's Date
 * parser, and there is no way to tell them apart from the string. This
 * codebase has already paid for that once — an order placed on 5 August was
 * confirmed to the customer as "8 May 2026" (CODEBASE §24) — and a coupon
 * silently starting three months early is the same bug with money attached.
 * So an ambiguous format is REFUSED with a message naming the one that works,
 * rather than accepted with a coin flip.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

function coerceDate(raw: string): CoerceResult {
  if (!ISO_DATE.test(raw)) {
    return err(
      "date_format",
      `"${raw}" isn't a date we can read without guessing. Use YYYY-MM-DD (for example 2026-08-07) — a date like 05/08/2026 could mean either 5 August or 8 May.`,
    );
  }
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime()))
    return err("date_invalid", `"${raw}" isn't a real date.`);
  return ok(d.toISOString());
}

/** Split a list cell. Both separators are accepted because gallery URLs
 *  contain commas often enough that a pipe-separated file is common. */
function splitList(raw: string): string[] {
  const sep = raw.includes("|") ? "|" : ",";
  return raw
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

function coerceUrl(raw: string): CoerceResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return err(
      "url_invalid",
      `"${truncate(raw)}" isn't a full URL. It needs to start with https://`,
    );
  }
  // http(s) only. A `javascript:` or `data:` URL in an image field renders
  // into the storefront, so the scheme check is a boundary, not tidiness.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return err(
      "url_scheme",
      `"${truncate(raw)}" isn't allowed — image and link URLs must be http or https.`,
    );
  }
  return ok(parsed.toString());
}

export function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Coerce one raw cell against its column definition.
 *
 * An EMPTY cell is never an error unless the column is required — leaving a
 * column blank is how a merchant says "don't change this", and the importer
 * treats an absent value as "leave alone" rather than "set to null".
 */
export function coerceCell(raw: string, col: ColumnDef): CoerceResult {
  const trimmed = raw.trim();

  if (trimmed === "") {
    if (col.required)
      return err(
        "required",
        `${col.key} is required and this row is missing it.`,
      );
    return ok(undefined);
  }

  switch (col.type) {
    case "text": {
      if (col.maxLength && trimmed.length > col.maxLength) {
        return ok(trimmed.slice(0, col.maxLength), {
          code: "truncated",
          message: `${col.key} was longer than ${col.maxLength} characters and was shortened.`,
        });
      }
      return ok(trimmed);
    }

    case "integer": {
      const n = toNumber(trimmed);
      if (n === null)
        return err(
          "not_a_number",
          `${col.key} must be a whole number — got "${truncate(trimmed)}".`,
        );
      // Excel stores every number as a float, so "45.0" is what a perfectly
      // ordinary stock column looks like. Accept an integral one; refuse a
      // genuinely fractional count rather than silently rounding it.
      if (!Number.isInteger(n)) {
        return err(
          "not_an_integer",
          `${col.key} must be a whole number — got "${truncate(trimmed)}".`,
        );
      }
      return rangeCheck(n, col);
    }

    case "decimal": {
      const n = toNumber(trimmed);
      if (n === null)
        return err(
          "not_a_number",
          `${col.key} must be a number — got "${truncate(trimmed)}".`,
        );
      const rounded = Math.round(n * 100) / 100;
      const checked = rangeCheck(rounded, col);
      if (!checked.ok) return checked;
      if (rounded !== n) {
        return ok(rounded, {
          code: "rounded",
          message: `${col.key} was rounded to ${rounded} — prices carry two decimal places.`,
        });
      }
      return checked;
    }

    case "boolean": {
      const word = trimmed.toLowerCase();
      if (TRUE_WORDS.has(word)) return ok(true);
      if (FALSE_WORDS.has(word)) return ok(false);
      return err(
        "not_a_boolean",
        `${col.key} must be TRUE or FALSE — got "${truncate(trimmed)}".`,
      );
    }

    case "enum": {
      const word = trimmed.toLowerCase();
      const aliased = col.enumAliases?.[word];
      const match = (col.enumValues ?? []).find(
        (v) => v.toLowerCase() === (aliased ?? word),
      );
      if (!match) {
        return err(
          "not_allowed",
          `${col.key} must be one of ${(col.enumValues ?? []).join(", ")} — got "${truncate(trimmed)}".`,
        );
      }
      return ok(match);
    }

    case "list":
      return ok(splitList(trimmed));

    case "url":
      return coerceUrl(trimmed);

    case "date":
      return coerceDate(trimmed);
  }
}

function rangeCheck(n: number, col: ColumnDef): CoerceResult {
  if (col.min !== undefined && n < col.min)
    return err(
      "below_min",
      `${col.key} can't be less than ${col.min} — got ${n}.`,
    );
  if (col.max !== undefined && n > col.max)
    return err(
      "above_max",
      `${col.key} can't be more than ${col.max} — got ${n}.`,
    );
  return ok(n);
}
