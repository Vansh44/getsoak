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
  previewImport,
} from "./import-export-actions";
import {
  getManagerIdentity,
  getViewerAccess,
} from "@/app/dashboard/lib/access";
import { getJob } from "@/lib/import-export/jobs";
import { rateLimit } from "@/lib/rate-limit";

const STORE = "a0000000-0000-4000-8000-000000000001";
const ADMIN = { uid: "admin-1", email: "owner@example.com" };

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
// The gate is `importGate`, shared by every import-side action. `startImport`
// used to be the vehicle for these; it was deleted when imports moved
// server-side (POST /api/dashboard/import gates the same way, inline), so they
// ride on previewImport — the remaining action that runs the identical gate.
describe("permission gate", () => {
  it("refuses an import when the caller can't manage the section", async () => {
    (getManagerIdentity as any).mockResolvedValue(null);
    const result = await previewImport("categories", []);
    expect(result.error).toContain("permission");
  });

  it("gates on the resource's own section", async () => {
    await previewImport("coupons", []);
    expect(getManagerIdentity).toHaveBeenCalledWith("marketing");
  });

  // Resolving a SKU is a product read; writing a count is an inventory write.
  // Holding one but not the other must not pass on the strength of the one.
  it("requires products as well as inventory for a stock import", async () => {
    (getManagerIdentity as any).mockImplementation(async (section: string) =>
      section === "inventory" ? ADMIN : null,
    );
    const result = await previewImport("inventory", []);
    expect(result.error).toContain("permission");
  });

  // ★ Orders are export-only: an imported order would carry an order_ref this
  // store never issued and reserve no stock.
  it("refuses to import orders at all", async () => {
    const result = await previewImport("orders", []);
    expect(result.error).toContain("not");
    expect(getManagerIdentity).not.toHaveBeenCalled();
  });

  it("refuses an unknown resource", async () => {
    const result = await previewImport("secrets", []);
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
