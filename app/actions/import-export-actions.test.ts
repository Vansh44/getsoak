/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));

vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
  getViewerAccess: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(async () => {}),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

// The job store is exercised by its own callers; here it is a seam, so these
// tests assert what the ACTION decides rather than how a row is written.
const jobs = vi.hoisted(() => ({
  current: {
    id: "job-1",
    kind: "import",
    resource: "categories",
    status: "running",
  } as any,
}));
vi.mock("@/lib/import-export/jobs", () => ({
  createJob: vi.fn(async () => "job-1"),
  getJob: vi.fn(async () => jobs.current),
  finishJob: vi.fn(async () => {}),
  addProgress: vi.fn(async () => {}),
  recordIssues: vi.fn(async () => ({ stored: 0, dropped: 0 })),
  listJobs: vi.fn(async () => ({ rows: [], total: 0 })),
  getJobIssues: vi.fn(async () => []),
  reapStaleJobs: vi.fn(async () => {}),
}));

const importers = vi.hoisted(() => ({
  categories: vi.fn(async () => []),
  products: vi.fn(async () => []),
  inventory: vi.fn(async () => []),
  coupons: vi.fn(async () => []),
}));
vi.mock("@/lib/import-export/importers/categories", () => ({
  importCategories: importers.categories,
}));
vi.mock("@/lib/import-export/importers/products", () => ({
  importProducts: importers.products,
}));
vi.mock("@/lib/import-export/importers/inventory", () => ({
  importInventory: importers.inventory,
}));
vi.mock("@/lib/import-export/importers/coupons", () => ({
  importCoupons: importers.coupons,
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  cancelImport,
  getImportExportJobs,
  importChunk,
  previewImport,
  startImport,
} from "./import-export-actions";
// From lib/, not the action: a "use server" file may only export async
// functions, so every constant the browser also needs lives outside it.
import { MAX_IMPORT_ROWS } from "@/lib/import-export/limits";
import {
  getManagerIdentity,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import { recordIssues, addProgress, getJob } from "@/lib/import-export/jobs";
import { rateLimit } from "@/lib/rate-limit";

const STORE = "a0000000-0000-4000-8000-000000000001";
const ADMIN = { uid: "admin-1", email: "owner@example.com" };

type RowIssueLike = { code: string; line: number; severity: string };

const row = (line: number, cells: string[]) => ({ line, cells });

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock({ selectQueue: [[]] });
  jobs.current = {
    id: "job-1",
    kind: "import",
    resource: "categories",
    status: "running",
    processedRows: 0,
  };
  (getManagerIdentity as any).mockResolvedValue(ADMIN);
  (getViewerAccess as any).mockResolvedValue({ can: () => true });
  (rateLimit as any).mockResolvedValue({ allowed: true });
  // clearAllMocks resets calls but KEEPS implementations, so a test that
  // points getJob at null would leak into every test after it.
  (getJob as any).mockImplementation(async () => jobs.current);
  for (const fn of Object.values(importers)) fn.mockResolvedValue([]);
});

// ★ The gate is the resource's OWN permission section. A separate
// `import_export` permission would look narrow while granting write access to
// the whole catalogue.
describe("permission gate", () => {
  it("refuses an import when the caller can't manage the section", async () => {
    (getManagerIdentity as any).mockResolvedValue(null);
    const result = await startImport({
      resource: "categories",
      totalRows: 1,
      header: ["Handle"],
    });
    expect(result.error).toContain("permission");
  });

  it("gates on the resource's own section", async () => {
    await startImport({
      resource: "coupons",
      totalRows: 1,
      header: ["Code"],
    });
    expect(getManagerIdentity).toHaveBeenCalledWith("marketing");
  });

  // Resolving a SKU is a product read; writing a count is an inventory write.
  // Holding one but not the other must not pass on the strength of the one.
  it("requires products as well as inventory for a stock import", async () => {
    (getManagerIdentity as any).mockImplementation(async (section: string) =>
      section === "inventory" ? ADMIN : null,
    );
    const result = await startImport({
      resource: "inventory",
      totalRows: 1,
      header: ["SKU"],
    });
    expect(result.error).toContain("permission");
  });

  // ★ Orders are export-only: an imported order would carry an order_ref this
  // store never issued and reserve no stock.
  it("refuses to import orders at all", async () => {
    const result = await startImport({
      resource: "orders",
      totalRows: 1,
      header: ["Order Ref"],
    });
    expect(result.error).toContain("not");
    expect(getManagerIdentity).not.toHaveBeenCalled();
  });

  it("refuses an unknown resource", async () => {
    const result = await startImport({
      resource: "secrets",
      totalRows: 1,
      header: ["x"],
    });
    expect(result.error).toBeDefined();
  });

  // The log is gated on `activity`, like the two logs beside it — a different
  // question from "may you import products".
  it("gates the history on the activity section", async () => {
    (getViewerAccess as any).mockResolvedValue({ can: () => false });
    const result = await getImportExportJobs();
    expect(result.error).toContain("permission");
  });
});

describe("startImport", () => {
  it("refuses a file over the row ceiling", async () => {
    const result = await startImport({
      resource: "categories",
      totalRows: MAX_IMPORT_ROWS + 1,
      header: ["Handle"],
    });
    expect(result.error).toContain("limited to");
  });

  it("refuses a file with no header", async () => {
    const result = await startImport({
      resource: "categories",
      totalRows: 5,
      header: [],
    });
    expect(result.error).toContain("header");
  });

  it("is rate limited per store", async () => {
    (rateLimit as any).mockResolvedValue({ allowed: false });
    const result = await startImport({
      resource: "categories",
      totalRows: 5,
      header: ["Handle"],
    });
    expect(result.error).toContain("try again");
    expect(rateLimit).toHaveBeenCalledWith(
      `import:${STORE}`,
      expect.anything(),
    );
  });

  it("returns a job id on the happy path", async () => {
    const result = await startImport({
      resource: "categories",
      totalRows: 5,
      header: ["Handle", "Name"],
    });
    expect(result.data?.jobId).toBe("job-1");
  });
});

describe("importChunk", () => {
  const chunk = (rows: { line: number; cells: string[] }[]) => ({
    jobId: "job-1",
    resource: "categories",
    header: ["Handle", "Name"],
    rows,
  });

  // getJob is store-scoped, so a job id from another store simply isn't found —
  // a chunk cannot be posted into another store's job with a valid session here.
  it("refuses a job belonging to another store", async () => {
    (getJob as any).mockResolvedValue(null);
    const result = await importChunk(chunk([row(2, ["dairy", "Dairy"])]));
    expect(result.error).toContain("can't be found");
  });

  // A chunk posted against a job for a different resource would run the wrong
  // importer over the merchant's data.
  it("refuses a chunk whose resource doesn't match the job", async () => {
    jobs.current = { ...jobs.current, resource: "coupons" };
    const result = await importChunk(chunk([row(2, ["dairy", "Dairy"])]));
    expect(result.error).toContain("something else");
  });

  it("refuses a chunk against a cancelled job", async () => {
    jobs.current = { ...jobs.current, status: "cancelled" };
    const result = await importChunk(chunk([row(2, ["dairy", "Dairy"])]));
    expect(result.error).toContain("cancelled");
  });

  it("refuses an oversized chunk", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      row(i + 2, ["dairy", "Dairy"]),
    );
    const result = await importChunk(chunk(rows));
    expect(result.error).toContain("too large");
  });

  // ★ The browser's parse is a courtesy. Everything is coerced again here
  // against the same registry before a row reaches an importer.
  it("re-validates server-side and never passes a bad row to the importer", async () => {
    const result = await importChunk({
      jobId: "job-1",
      resource: "categories",
      header: ["Handle", "Name", "Status"],
      rows: [
        row(2, ["dairy", "Dairy", "active"]),
        row(3, ["", "No handle", "active"]),
        row(4, ["bakery", "Bakery", "not-a-status"]),
      ],
    });

    expect(result.data?.failed).toBe(2);
    const passed = (importers.categories.mock.calls as any)[0][1] as any[];
    expect(passed).toHaveLength(1);
    expect(passed[0].values.handle).toBe("dairy");
  });

  // ★ A header-level note ("the Vendor column was ignored") explains why a
  // whole column appears to have done nothing. Every chunk re-derives it, so it
  // is recorded once — repeating it 100 times would bury the row errors, and
  // dropping it entirely leaves the merchant with no explanation at all.
  it("records header-level notes on the first chunk only", async () => {
    const withVendor = {
      jobId: "job-1",
      resource: "categories",
      header: ["Handle", "Name", "Vendor"],
      rows: [row(2, ["dairy", "Dairy", "Amul"])],
    };

    await importChunk(withVendor);
    const first = (recordIssues as any).mock.calls[0][2] as RowIssueLike[];
    expect(first.some((i) => i.code === "unknown_column")).toBe(true);

    // A later chunk: the job has already processed rows.
    jobs.current = { ...jobs.current, processedRows: 200 };
    (recordIssues as any).mockClear();
    await importChunk(withVendor);
    const later = ((recordIssues as any).mock.calls[0]?.[2] ??
      []) as RowIssueLike[];
    expect(later.some((i) => i.code === "unknown_column")).toBe(false);
  });

  it("writes the rejected rows' reasons to the error log", async () => {
    await importChunk({
      jobId: "job-1",
      resource: "categories",
      header: ["Handle", "Name"],
      rows: [row(2, ["", "No handle"])],
    });

    const issues = (recordIssues as any).mock.calls[0][2];
    expect(issues[0]).toMatchObject({
      line: 2,
      column: "Handle",
      severity: "error",
    });
  });

  // ★ A thrown importer must not leave the job looking like it is still
  // running — the merchant would watch a spinner forever.
  it("records the failure and keeps counting when an importer throws", async () => {
    importers.categories.mockRejectedValue(new Error("connection lost"));
    const result = await importChunk(chunk([row(2, ["dairy", "Dairy"])]));

    expect(result.error).toBeDefined();
    expect(recordIssues).toHaveBeenCalled();
    expect(addProgress).toHaveBeenCalledWith(
      "job-1",
      STORE,
      expect.objectContaining({ failed: 1, processed: 1 }),
    );
  });

  it("counts outcomes from the importer's results", async () => {
    importers.categories.mockResolvedValue([
      { lines: [2], outcome: "created", issues: [] },
      { lines: [3], outcome: "updated", issues: [] },
      { lines: [4], outcome: "skipped", issues: [] },
    ] as any);

    const result = await importChunk(
      chunk([row(2, ["a", "A"]), row(3, ["b", "B"]), row(4, ["c", "C"])]),
    );

    expect(result.data).toMatchObject({
      created: 1,
      updated: 1,
      skipped: 1,
      failed: 0,
    });
  });

  it("accepts an empty chunk without touching the importer", async () => {
    const result = await importChunk(chunk([]));
    expect(result.success).toBe(true);
    expect(importers.categories).not.toHaveBeenCalled();
  });
});

describe("previewImport", () => {
  it("returns the match values the store already has", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ slug: "dairy" }]] });
    const result = await previewImport("categories", ["dairy", "bakery"]);
    expect(result.data?.existing).toEqual(["dairy"]);
  });

  // A preview is an optimisation — losing it must not stop the import.
  it("degrades to an empty answer when the lookup fails", async () => {
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("db down");
        },
      },
    };
    const result = await previewImport("categories", ["dairy"]);
    expect(result.success).toBe(true);
    expect(result.data?.existing).toEqual([]);
  });
});

// ★ Cancelling stops the REST of the file. Rows already written stay written,
// and the job says so — silently deleting them would be far worse.
describe("cancelImport", () => {
  it("marks the job cancelled and says what was kept", async () => {
    const { finishJob } = await import("@/lib/import-export/jobs");
    const result = await cancelImport("job-1", "categories");
    expect(result.success).toBe(true);
    expect(finishJob).toHaveBeenCalledWith(
      "job-1",
      STORE,
      expect.objectContaining({ status: "cancelled" }),
    );
    expect((finishJob as any).mock.calls[0][2].error).toContain("kept");
  });
});
