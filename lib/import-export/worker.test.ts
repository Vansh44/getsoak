/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The worker is the server-side half of §31. These tests cover the two things
// that decide correctness: how a run carves the file into slices, and what
// applying one slice does — the row-atomic contract that used to be pinned
// against `importChunk` before imports moved off the browser.

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
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
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn({})),
}));

// The job store is a seam here: these tests assert what the WORKER decides,
// not how a row is written.
vi.mock("./jobs", () => ({
  ISSUE_CAP: 1000,
  createJob: vi.fn(async () => "job-1"),
  getJob: vi.fn(async () => ({ status: "completed" })),
  finishJob: vi.fn(async () => {}),
  addProgress: vi.fn(async () => {}),
  recordIssues: vi.fn(async () => ({ stored: 0, dropped: 0 })),
}));

const importers = vi.hoisted(() => ({
  categories: vi.fn(async () => [] as any[]),
  products: vi.fn(async () => [] as any[]),
  inventory: vi.fn(async () => [] as any[]),
  coupons: vi.fn(async () => [] as any[]),
}));
vi.mock("./importers/categories", () => ({
  importCategories: importers.categories,
}));
vi.mock("./importers/products", () => ({ importProducts: importers.products }));
vi.mock("./importers/inventory", () => ({
  importInventory: importers.inventory,
}));
vi.mock("./importers/coupons", () => ({ importCoupons: importers.coupons }));

import {
  applySlice,
  budgetSpent,
  sliceBounds,
  SLICE_BUDGET_MS,
  SLICE_MAX_ROWS,
  type ClaimedJob,
} from "./worker";
import { addProgress, recordIssues } from "./jobs";

const JOB: ClaimedJob = {
  id: "job-1",
  storeId: "store-1",
  resource: "categories",
  filename: "a.csv",
  totalRows: 3,
  cursor: 0,
  attempts: 1,
  options: {},
  createdBy: "uid-1",
  actorEmail: "a@b.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  importers.categories.mockResolvedValue([]);
});

describe("sliceBounds", () => {
  it("takes a full slice from the start", () => {
    expect(sliceBounds(0, 10_000, 500)).toEqual({
      from: 0,
      to: 500,
      done: false,
    });
  });

  it("resumes from the cursor — this is what makes a killed worker safe", () => {
    expect(sliceBounds(500, 10_000, 500)).toEqual({
      from: 500,
      to: 1000,
      done: false,
    });
  });

  it("stops at the end of the file rather than past it", () => {
    expect(sliceBounds(9_900, 10_000, 500)).toEqual({
      from: 9_900,
      to: 10_000,
      done: false,
    });
  });

  it("reports done when the cursor has reached the end", () => {
    expect(sliceBounds(10_000, 10_000, 500).done).toBe(true);
  });

  // A cursor past the end (a shrunken file, a bad write) must not produce a
  // negative or reversed range that slices the array from the wrong end.
  it("clamps a cursor beyond the file", () => {
    const b = sliceBounds(50_000, 10_000, 500);
    expect(b.from).toBe(10_000);
    expect(b.to).toBe(10_000);
    expect(b.done).toBe(true);
  });

  it("never asks for a zero-row slice, which would not advance", () => {
    expect(sliceBounds(0, 10, 0).to).toBeGreaterThan(0);
  });

  it("defaults to the configured maximum", () => {
    expect(sliceBounds(0, 10_000).to).toBe(SLICE_MAX_ROWS);
  });
});

describe("budgetSpent", () => {
  it("keeps going inside the budget", () => {
    expect(budgetSpent(1_000, 1_000 + SLICE_BUDGET_MS - 1)).toBe(false);
  });

  // The route's maxDuration is 60s and the budget is 40s, so stopping ON the
  // boundary is what leaves room to write progress and chain the next run.
  it("stops at the boundary", () => {
    expect(budgetSpent(1_000, 1_000 + SLICE_BUDGET_MS)).toBe(true);
  });
});

describe("applySlice", () => {
  const header = ["Handle"];
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      line: i + 2,
      cells: [`cat-${i + 1}`],
    }));

  it("re-validates server-side and never passes a bad row to the importer", async () => {
    // A row the registry rejects must not reach an importer — the stored file
    // is the merchant's own bytes, so nothing upstream has validated it.
    await applySlice(JOB, header, [{ line: 2, cells: [""] }], true);
    const passed = (importers.categories.mock.calls[0] as any)?.[1] as
      | any[]
      | undefined;
    expect(passed ?? []).toHaveLength(0);
  });

  it("counts a rejected row as failed rather than dropping it", async () => {
    await applySlice(JOB, header, [{ line: 2, cells: [""] }], true);
    const delta = (addProgress as any).mock.calls[0][2];
    expect(delta.processed).toBe(1);
    expect(delta.failed).toBe(1);
  });

  it("writes the rejected row's reason to the error log", async () => {
    await applySlice(JOB, header, [{ line: 2, cells: [""] }], true);
    const issues = (recordIssues as any).mock.calls[0][2];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({ severity: "error" });
  });

  it("counts the outcomes an importer reports", async () => {
    importers.categories.mockResolvedValue([
      { outcome: "created", issues: [] },
      { outcome: "updated", issues: [] },
      { outcome: "skipped", issues: [] },
    ] as any);
    await applySlice(JOB, header, rows(3), true);
    const delta = (addProgress as any).mock.calls[0][2];
    expect(delta).toMatchObject({
      processed: 3,
      created: 1,
      updated: 1,
      skipped: 1,
      failed: 0,
    });
  });

  // ★ Header-level notes describe the FILE, so every slice re-derives the same
  // set. Repeating them per slice would bury the row errors; dropping them
  // entirely loses the one note explaining why a whole column was ignored.
  it("records header-level notes on the first slice only", async () => {
    const withUnknown = ["Handle", "Nonsense"];
    await applySlice(
      JOB,
      withUnknown,
      [{ line: 2, cells: ["cat-a", "x"] }],
      true,
    );
    const first = (recordIssues as any).mock.calls[0][2] as any[];
    const firstFileIssues = first.filter((i) => i.line === 0);

    vi.clearAllMocks();
    importers.categories.mockResolvedValue([]);

    await applySlice(
      JOB,
      withUnknown,
      [{ line: 3, cells: ["cat-b", "x"] }],
      false,
    );
    const later = (recordIssues as any).mock.calls[0][2] as any[];

    expect(firstFileIssues.length).toBeGreaterThan(0);
    expect(later.filter((i) => i.line === 0)).toHaveLength(0);
  });

  it("throws for a resource that cannot be imported, so the run records it", async () => {
    // Orders are export-only. The worker's catch turns this into a recorded
    // job failure rather than a silent stall.
    await expect(
      applySlice({ ...JOB, resource: "orders" }, ["Order Ref"], rows(1), true),
    ).rejects.toThrow();
  });
});
