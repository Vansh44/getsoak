import { describe, it, expect } from "vitest";
import { parseCsv } from "@/lib/csv/parse";
import { coerceCell, normalizeHeader } from "./coerce";
import {
  crossRowIssues,
  groupProductRows,
  mapHeaders,
  parseFile,
} from "./parse";
import {
  RESOURCES,
  exportHeader,
  getResource,
  templateRows,
  toCells,
  writableColumns,
} from "./resources";
import { EXPORT_FIELDS } from "./exporters";
import type { ColumnDef, ParsedFile } from "./types";

const products = getResource("products")!;
const categories = getResource("categories")!;
const coupons = getResource("coupons")!;

function ok(result: ParsedFile | { error: string }): ParsedFile {
  if ("error" in result)
    throw new Error(`expected a parse, got: ${result.error}`);
  return result;
}

// The registry is what every other layer reads. A malformed entry would not
// fail loudly — it would quietly drop a column from imports AND exports.
describe("registry integrity", () => {
  it("gives every column a unique key and field per resource", () => {
    for (const resource of RESOURCES) {
      const keys = resource.columns.map((c) => c.key);
      const fields = resource.columns.map((c) => c.field);
      expect(new Set(keys).size, `${resource.id} keys`).toBe(keys.length);
      expect(new Set(fields).size, `${resource.id} fields`).toBe(fields.length);
    }
  });

  // Two columns normalising to the same header means one of them can never be
  // matched — and which one wins would depend on declaration order.
  it("has no two columns colliding after header normalisation", () => {
    for (const resource of RESOURCES) {
      const seen = new Map<string, string>();
      for (const col of resource.columns) {
        for (const name of [col.key, ...(col.aliases ?? [])]) {
          const norm = normalizeHeader(name);
          const prior = seen.get(norm);
          // A canonical key may shadow another column's alias (mapHeaders
          // resolves that deliberately); two canonical KEYS may not collide.
          const isCanonical = name === col.key;
          const priorWasCanonical = prior && prior === norm;
          if (prior && isCanonical && priorWasCanonical) {
            throw new Error(`${resource.id}: "${name}" collides`);
          }
          if (!prior) seen.set(norm, isCanonical ? norm : col.key);
        }
      }
    }
  });

  it("declares a match column for every importable resource", () => {
    for (const resource of RESOURCES) {
      if (!resource.canImport) continue;
      expect(resource.matchOn.length, `${resource.id}`).toBeGreaterThan(0);
      const key = resource.matchOn[0];
      expect(resource.columns.some((c) => c.key === key)).toBe(true);
    }
  });

  // ★ Orders are export-only on purpose: an imported order would carry an
  // order_ref this store never issued, reserve no stock and take no money.
  it("keeps orders export-only with no writable column", () => {
    const orders = getResource("orders")!;
    expect(orders.canImport).toBe(false);
    expect(writableColumns(orders)).toHaveLength(0);
  });

  it("omits read-only columns from the template", () => {
    const template = templateRows(products);
    expect(template.header).not.toContain("SKU");
    expect(template.header).toContain("Handle");
    expect(template.header.length).toBe(template.example.length);
  });

  it("gives every enum column its allowed values", () => {
    for (const resource of RESOURCES) {
      for (const col of resource.columns) {
        if (col.type !== "enum") continue;
        expect(
          col.enumValues?.length,
          `${resource.id}.${col.key}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

// ★ The guard that replaces positional discipline in the exporters. Before
// `toCells`, each exporter built its own array and had to stay in step with the
// registry by hand — add a column, forget one exporter, and every cell after it
// shifts by one, so prices land in the stock column and the file still looks
// plausible enough to reimport.
describe("export field coverage", () => {
  it("emits only fields the registry declares", () => {
    for (const resource of RESOURCES) {
      const declared = new Set(resource.columns.map((c) => c.field));
      for (const field of EXPORT_FIELDS[resource.id]) {
        expect(
          declared.has(field),
          `${resource.id}.${field} is not a column`,
        ).toBe(true);
      }
    }
  });

  // A registry column no exporter fills is a permanently blank column in every
  // download — and on a round trip it silently clears that field.
  it("fills every column the registry declares", () => {
    for (const resource of RESOURCES) {
      const emitted = new Set(EXPORT_FIELDS[resource.id]);
      for (const col of resource.columns) {
        expect(
          emitted.has(col.field),
          `${resource.id}.${col.key} is exported as always-blank`,
        ).toBe(true);
      }
    }
  });

  it("lays a record out in column order, blanking what's absent", () => {
    const cells = toCells(categories, { handle: "dairy", name: "Dairy" });
    expect(cells).toHaveLength(categories.columns.length);
    expect(cells[0]).toBe("dairy");
    expect(cells[1]).toBe("Dairy");
    expect(cells[2]).toBeNull();
  });

  it("keeps the header and a laid-out row the same width", () => {
    for (const resource of RESOURCES) {
      const header = exportHeader(resource);
      const row = toCells(resource, {});
      expect(row.length, resource.id).toBe(header.length);
    }
  });
});

describe("coerceCell", () => {
  const price: ColumnDef = {
    key: "Price",
    field: "price",
    type: "decimal",
    min: 0,
  };
  const qty: ColumnDef = { key: "Qty", field: "qty", type: "integer", min: 0 };

  // Blank means "leave this alone", which is what makes a partial-column file
  // (just Handle + Price) a safe way to change only prices.
  it("treats a blank optional cell as absent, not null", () => {
    const result = coerceCell("", price);
    expect(result).toEqual({ ok: true, value: undefined, note: undefined });
  });

  it("rejects a blank required cell", () => {
    const result = coerceCell("  ", { ...price, required: true });
    expect(result.ok).toBe(false);
  });

  it("strips currency symbols and thousands separators", () => {
    expect(coerceCell("₹1,234.50", price)).toMatchObject({ value: 1234.5 });
    expect(coerceCell("$ 99", price)).toMatchObject({ value: 99 });
  });

  it("refuses values Number() would be too generous about", () => {
    expect(coerceCell("1e5", price).ok).toBe(false);
    expect(coerceCell("0x10", price).ok).toBe(false);
    expect(coerceCell("Infinity", price).ok).toBe(false);
    expect(coerceCell("12.3.4", price).ok).toBe(false);
  });

  // Excel stores every number as a float, so "45.0" is an ordinary stock cell.
  it("accepts an integral float for an integer column", () => {
    expect(coerceCell("45.0", qty)).toMatchObject({ value: 45 });
  });

  it("refuses a genuinely fractional count rather than rounding it", () => {
    expect(coerceCell("45.5", qty).ok).toBe(false);
  });

  it("rounds a price to two places and says so", () => {
    const result = coerceCell("10.005", price);
    expect(result).toMatchObject({ ok: true, value: 10.01 });
    expect((result as { note?: unknown }).note).toBeDefined();
  });

  it("enforces min and max", () => {
    expect(coerceCell("-1", price).ok).toBe(false);
    expect(coerceCell("400", { ...qty, max: 365 }).ok).toBe(false);
  });

  it("reads the boolean spellings a spreadsheet produces", () => {
    const col: ColumnDef = { key: "On", field: "on", type: "boolean" };
    for (const yes of ["TRUE", "yes", "Y", "1", "active"])
      expect(coerceCell(yes, col)).toMatchObject({ value: true });
    for (const no of ["FALSE", "no", "N", "0", "draft"])
      expect(coerceCell(no, col)).toMatchObject({ value: false });
    expect(coerceCell("maybe", col).ok).toBe(false);
  });

  it("maps enum aliases and is case-insensitive", () => {
    const col = products.columns.find((c) => c.key === "Status")!;
    expect(coerceCell("ACTIVE", col)).toMatchObject({ value: "published" });
    expect(coerceCell("Draft", col)).toMatchObject({ value: "draft" });
    expect(coerceCell("archived", col)).toMatchObject({ value: "draft" });
    expect(coerceCell("sometime", col).ok).toBe(false);
  });

  it("splits a list on pipes in preference to commas", () => {
    const col = products.columns.find((c) => c.key === "Gallery Image URLs")!;
    expect(coerceCell("https://a/1.webp|https://a/2.webp", col)).toMatchObject({
      value: ["https://a/1.webp", "https://a/2.webp"],
    });
  });

  // A javascript: URL in an image field renders into the storefront, so the
  // scheme check is a boundary rather than tidiness.
  it("rejects non-http(s) URLs", () => {
    const col: ColumnDef = { key: "Image URL", field: "imageUrl", type: "url" };
    expect(coerceCell("javascript:alert(1)", col).ok).toBe(false);
    expect(coerceCell("data:text/html,<script>", col).ok).toBe(false);
    expect(coerceCell("not a url", col).ok).toBe(false);
    expect(coerceCell("https://example.com/a.webp", col).ok).toBe(true);
  });

  // ★ 05/08/2026 is 5 August to the merchant and 8 May to V8's parser. This
  // codebase has already shipped that bug once (CODEBASE §24); an ambiguous
  // date is refused rather than resolved by coin flip.
  it("accepts ISO dates and refuses ambiguous ones", () => {
    const col = coupons.columns.find((c) => c.key === "Valid From")!;
    expect(coerceCell("2026-08-07", col)).toMatchObject({
      value: "2026-08-07T00:00:00.000Z",
    });
    const bad = coerceCell("05/08/2026", col);
    expect(bad.ok).toBe(false);
    expect((bad as { message: string }).message).toContain("YYYY-MM-DD");
  });

  it("truncates over-long text with a warning rather than failing", () => {
    const col: ColumnDef = {
      key: "Name",
      field: "name",
      type: "text",
      maxLength: 5,
    };
    const result = coerceCell("abcdefgh", col);
    expect(result).toMatchObject({ ok: true, value: "abcde" });
  });
});

describe("mapHeaders", () => {
  it("matches regardless of case, spaces and underscores", () => {
    const map = mapHeaders(products, ["handle", "SELLING_PRICE", "Base Price"]);
    expect(map.presentColumns).toEqual([
      "Handle",
      "Selling Price",
      "Base Price",
    ]);
    expect(map.unknownHeaders).toEqual([]);
  });

  it("matches Shopify's column names through aliases", () => {
    const map = mapHeaders(products, ["Handle", "Body (HTML)", "Image Src"]);
    expect(map.presentColumns).toEqual(["Handle", "Description", "Image URL"]);
  });

  it("collects unknown headers instead of failing", () => {
    const map = mapHeaders(categories, ["Handle", "Vendor", "Metafield: x"]);
    expect(map.presentColumns).toEqual(["Handle"]);
    expect(map.unknownHeaders).toEqual(["Vendor", "Metafield: x"]);
  });

  // Keeping the FIRST matters: an appended blank duplicate would otherwise
  // silently erase the populated column before it.
  it("keeps the first of two headers feeding one column", () => {
    const map = mapHeaders(categories, ["Handle", "Name", "Title"]);
    expect(map.duplicateHeaders).toEqual(["Title"]);
    expect(map.byIndex[2]).toBeNull();
  });
});

describe("parseFile", () => {
  it("parses a well-formed category file", () => {
    const file = ok(
      parseFile(
        "categories",
        parseCsv(
          "Handle,Name,Status\ndairy,Dairy,active\nbakery,Bakery,hidden\n",
        ),
      ),
    );
    expect(file.records).toHaveLength(2);
    expect(file.records[0].values).toEqual({
      handle: "dairy",
      name: "Dairy",
      status: "active",
    });
    expect(file.records.every((r) => r.ok)).toBe(true);
  });

  // ★ Without the match column the import cannot tell a correction from a
  // duplicate, so it stops rather than creating a second copy of the catalogue.
  it("refuses a file with no match column", () => {
    const result = parseFile(
      "categories",
      parseCsv("Name,Status\nDairy,active\n"),
    );
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("Handle");
  });

  it("refuses to import an export-only resource", () => {
    const result = parseFile("orders", parseCsv("Order Ref\nORD1\n"));
    expect((result as { error: string }).error).toContain("not");
  });

  it("reports a header with no rows", () => {
    const file = ok(parseFile("categories", parseCsv("Handle,Name\n")));
    expect(file.fileIssues.some((i) => i.code === "empty")).toBe(true);
  });

  it("keeps a bad row's errors without sinking the good rows", () => {
    const file = ok(
      parseFile(
        "coupons",
        parseCsv(
          "Code,Discount Type,Discount Value\nGOOD,percentage,10\nBAD,bogus,10\nALSOGOOD,fixed,50\n",
        ),
      ),
    );
    expect(file.records.filter((r) => r.ok)).toHaveLength(2);
    const bad = file.records.find((r) => !r.ok)!;
    expect(bad.line).toBe(3);
    expect(bad.issues[0].column).toBe("Discount Type");
  });

  // The line number is what the merchant looks up in their spreadsheet.
  it("attributes errors to the original file line", () => {
    const file = ok(
      parseFile(
        "categories",
        parseCsv('Handle,Name\n\ndairy,"Dairy\nfoods"\n,Missing\n'),
      ),
    );
    const failed = file.records.find((r) => !r.ok)!;
    expect(failed.line).toBe(5);
  });

  it("warns about unknown and ragged columns rather than failing", () => {
    const file = ok(
      parseFile("categories", parseCsv("Handle,Name,Vendor\ndairy,Dairy\n")),
    );
    expect(file.fileIssues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["unknown_column", "ragged_row"]),
    );
    expect(file.records[0].ok).toBe(true);
  });

  // Read-only columns survive an export→edit→reimport round trip untouched.
  it("ignores read-only columns on import", () => {
    const file = ok(
      parseFile("coupons", parseCsv("Code,Used Count\nWELCOME10,999\n")),
    );
    expect(file.records[0].values).toEqual({ code: "WELCOME10" });
  });
});

describe("groupProductRows", () => {
  const parse = (csv: string) => ok(parseFile("products", parseCsv(csv)));

  it("folds rows sharing a handle into one product with variants", () => {
    const file = parse(
      [
        "Handle,Title,Selling Price,Variant Name,Variant Selling Price",
        "milk,Toned Milk,50,500 ml,30",
        "milk,,,1 L,50",
        "bread,Brown Bread,40,,",
      ].join("\n"),
    );
    const drafts = groupProductRows(file.records);
    expect(drafts).toHaveLength(2);

    const milk = drafts.find((d) => d.handle === "milk")!;
    expect(milk.values.name).toBe("Toned Milk");
    expect(milk.variants.map((v) => v.name)).toEqual(["500 ml", "1 L"]);
    expect(milk.lines).toEqual([2, 3]);

    const bread = drafts.find((d) => d.handle === "bread")!;
    expect(bread.variants).toHaveLength(0);
  });

  // A spreadsheet fill-down repeats product fields on every variant row, and a
  // blank cell there must never erase what the first row set.
  it("takes the first defined value for a product field", () => {
    const file = parse(
      [
        "Handle,Title,Selling Price,Variant Name",
        "milk,Toned Milk,50,500 ml",
        "milk,Something Else,,1 L",
      ].join("\n"),
    );
    const [draft] = groupProductRows(file.records);
    expect(draft.values.name).toBe("Toned Milk");
    expect(draft.values.sellingPrice).toBe(50);
  });

  // Slugs are unique case-insensitively in the database, so treating these as
  // two products would fail on the unique index after creating one of them.
  it("treats handles case-insensitively", () => {
    const file = parse(
      "Handle,Title,Variant Name\nMilk,Toned Milk,500 ml\nmilk,,1 L\n",
    );
    expect(groupProductRows(file.records)).toHaveLength(1);
  });

  it("skips rows that failed validation", () => {
    const file = parse(
      "Handle,Title,Selling Price\nmilk,Toned Milk,50\nbread,Bread,not-a-price\n",
    );
    const drafts = groupProductRows(file.records);
    expect(drafts.map((d) => d.handle)).toEqual(["milk"]);
  });
});

describe("crossRowIssues", () => {
  it("warns when a match key repeats", () => {
    const file = ok(
      parseFile("coupons", parseCsv("Code\nWELCOME10\nwelcome10\n")),
    );
    const issues = crossRowIssues(coupons, file.records);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 3, code: "duplicate_row" });
  });

  // Products EXPECT repeats — that is how variants are expressed.
  it("never flags repeated product handles", () => {
    const file = ok(
      parseFile(
        "products",
        parseCsv("Handle,Title,Variant Name\nmilk,Milk,500 ml\nmilk,,1 L\n"),
      ),
    );
    expect(crossRowIssues(products, file.records)).toEqual([]);
  });
});
