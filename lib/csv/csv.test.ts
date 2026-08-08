import { describe, it, expect } from "vitest";
import { parseCsv, sniffDelimiter } from "./parse";
import { guardFormula, serializeCsv, serializeCsvRow } from "./serialize";

// The parser is the boundary between a merchant's spreadsheet and our data.
// Every case below is something a real export produces, not a hypothetical.
describe("parseCsv", () => {
  it("reads a plain file", () => {
    const out = parseCsv("Name,Price\nMilk,45\nBread,30\n");
    expect(out.header).toEqual(["Name", "Price"]);
    expect(out.rows.map((r) => r.cells)).toEqual([
      ["Milk", "45"],
      ["Bread", "30"],
    ]);
  });

  // Excel writes a BOM. Left in place it becomes part of the first header name,
  // so that column silently matches nothing.
  it("strips a UTF-8 BOM from the first header", () => {
    const out = parseCsv("﻿Handle,Title\nmilk,Milk\n");
    expect(out.header).toEqual(["Handle", "Title"]);
  });

  it("handles quoted fields containing the delimiter", () => {
    const out = parseCsv('Name,Note\n"Milk, whole",fresh\n');
    expect(out.rows[0].cells).toEqual(["Milk, whole", "fresh"]);
  });

  it("handles doubled quotes inside a quoted field", () => {
    const out = parseCsv('Name\n"He said ""hi"""\n');
    expect(out.rows[0].cells).toEqual(['He said "hi"']);
  });

  it("handles newlines inside a quoted field", () => {
    const out = parseCsv('Name,Description\nMilk,"Line one\nLine two"\n');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].cells[1]).toBe("Line one\nLine two");
  });

  it("handles CRLF, LF and bare CR line endings", () => {
    expect(parseCsv("A,B\r\n1,2\r\n").rows[0].cells).toEqual(["1", "2"]);
    expect(parseCsv("A,B\n1,2\n").rows[0].cells).toEqual(["1", "2"]);
    expect(parseCsv("A,B\r1,2\r").rows[0].cells).toEqual(["1", "2"]);
  });

  it("reads a final row with no trailing newline", () => {
    const out = parseCsv("A,B\n1,2");
    expect(out.rows[0].cells).toEqual(["1", "2"]);
  });

  // A single trailing newline produces one of these in every well-formed file,
  // and Excel litters more. Reporting "empty row" for each would bury the real
  // errors under noise the merchant cannot act on.
  it("drops wholly empty rows", () => {
    const out = parseCsv("A,B\n1,2\n\n\n , \n");
    expect(out.rows).toHaveLength(1);
  });

  // The line number is what an error message points at, so it must survive
  // both blank lines and newlines embedded in quoted fields.
  it("reports the original file line, not the row index", () => {
    const out = parseCsv('A,B\n\n1,"two\nlines"\n3,4\n');
    expect(out.rows.map((r) => r.line)).toEqual([3, 5]);
  });

  it("flags ragged rows without dropping them", () => {
    const out = parseCsv("A,B,C\n1,2,3\n4,5\n");
    expect(out.raggedLines).toEqual([3]);
    expect(out.rows).toHaveLength(2);
  });

  // Malformed, but the intent is never in doubt — a 6" cable is not an error.
  it("keeps a stray quote inside a quoted field as a literal", () => {
    const out = parseCsv('Name\n"6" cable"\n');
    expect(out.rows[0].cells[0]).toBe('6" cable');
  });

  it("stops at maxRows and reports truncation", () => {
    const out = parseCsv("A\n1\n2\n3\n4\n", { maxRows: 2 });
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("returns an empty header for empty input", () => {
    expect(parseCsv("").header).toEqual([]);
    expect(parseCsv("").rows).toEqual([]);
  });
});

describe("sniffDelimiter", () => {
  it("defaults to comma", () => {
    expect(sniffDelimiter("A,B,C\n1,2,3")).toBe(",");
  });

  // Excel writes semicolons in every locale that uses a comma as the decimal
  // separator. Guessing comma there reads each row as one giant cell.
  it("detects semicolons", () => {
    expect(sniffDelimiter("A;B;C\n1;2;3")).toBe(";");
  });

  it("detects tabs", () => {
    expect(sniffDelimiter("A\tB\tC\n1\t2\t3")).toBe("\t");
  });

  // The reason this is quote-aware: one ordinary header cell would otherwise
  // outvote the real delimiter.
  it("ignores delimiters inside quoted header cells", () => {
    expect(sniffDelimiter('"Name, legal";Price\n')).toBe(";");
  });

  it("only looks at the first line", () => {
    expect(sniffDelimiter("A,B\n1;2;3;4;5")).toBe(",");
  });
});

// A cell beginning = + - @ tab or CR executes as a formula on open. The export
// carries customer-supplied text, so the attacker needs no account here.
describe("guardFormula", () => {
  it("neutralises formula-leading values", () => {
    expect(guardFormula("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(guardFormula("+1+1")).toBe("'+1+1");
    expect(guardFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(guardFormula("\tcmd")).toBe("'\tcmd");
  });

  // ★ The naive rule mangles every negative number in the file, so the guard
  // would break the round trip it exists inside.
  it("leaves plain numbers alone, including negatives", () => {
    expect(guardFormula("-5")).toBe("-5");
    expect(guardFormula("-5.25")).toBe("-5.25");
    expect(guardFormula("42")).toBe("42");
  });

  it("still guards a negative-looking value carrying a payload", () => {
    expect(guardFormula("-5+cmd|' /C calc'!A0")).toBe("'-5+cmd|' /C calc'!A0");
  });

  it("passes ordinary text through untouched", () => {
    expect(guardFormula("Milk 1 L")).toBe("Milk 1 L");
  });
});

describe("serializeCsv", () => {
  it("quotes only what needs quoting", () => {
    const out = serializeCsvRow(["plain", "has,comma", 'has"quote', "a\nb"]);
    expect(out).toBe('plain,"has,comma","has""quote","a\nb"\r\n');
  });

  it("preserves significant whitespace by quoting", () => {
    expect(serializeCsvRow([" padded "])).toBe('" padded "\r\n');
  });

  it("writes empties for null and undefined", () => {
    expect(serializeCsvRow([null, undefined, 0, false])).toBe(",,0,FALSE\r\n");
  });

  it("prepends a BOM by default and omits it on request", () => {
    expect(serializeCsv(["A"], [["1"]]).startsWith("﻿")).toBe(true);
    expect(serializeCsv(["A"], [["1"]], { bom: false }).startsWith("﻿")).toBe(
      false,
    );
  });

  // The two halves must agree, or an export the merchant never edits fails to
  // reimport — which is the first thing anyone tries.
  it("round-trips through the parser", () => {
    const header = ["Name", "Note", "Price"];
    const rows = [
      ["Milk, whole", 'He said "hi"', "45"],
      ["Bread", "Line one\nLine two", "-30"],
    ];
    const parsed = parseCsv(serializeCsv(header, rows));
    expect(parsed.header).toEqual(header);
    expect(parsed.rows.map((r) => r.cells)).toEqual(rows);
  });
});
