import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  allowed: true,
  topProducts: vi.fn(),
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: vi.fn(async () => ({
    userId: "admin-1",
    userEmail: "owner@example.com",
    storeId: "store-1",
    permissions: {},
    isSuperadmin: true,
  })),
}));
vi.mock("@/app/dashboard/lib/permissions", () => ({
  can: vi.fn(() => holder.allowed),
}));
vi.mock("@/app/dashboard/analytics/data", () => ({
  getAnalyticsLocationOptions: vi.fn(async () => [
    { id: "loc-allowed", name: "Allowed shop" },
  ]),
  getSalesAnalytics: vi.fn(),
  getTopProducts: holder.topProducts,
}));
vi.mock("@/app/dashboard/analytics/search-data", () => ({
  getSearchRankingReport: vi.fn(),
}));
vi.mock("@/app/dashboard/analytics/reports/data", () => ({
  getTotalSalesReport: vi.fn(),
}));
vi.mock("@/lib/analytics/settings", () => ({
  getStoreAnalyticsTimeZone: vi.fn(async () => "Asia/Kolkata"),
}));
vi.mock("@/lib/locations/scope", () => ({
  getViewerLocations: vi.fn(async () => ["loc-allowed"]),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  holder.allowed = true;
  holder.topProducts.mockResolvedValue([
    { id: "product-1", name: "=unsafe", units: 3, amount: 450 },
  ]);
});

describe("analytics report CSV", () => {
  it("re-derives location scope and neutralizes spreadsheet formulas", async () => {
    const response = await GET(
      new Request(
        "https://acme.storemink.com/api/dashboard/analytics/reports/top-products?range=7d&compare=none&location=loc-forged",
      ),
      { params: Promise.resolve({ report: "top-products" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(holder.topProducts).toHaveBeenCalledWith(
      "store-1",
      {
        locationIds: ["loc-allowed"],
        includeUnassigned: true,
        selectedId: null,
      },
      expect.any(Object),
      10_000,
    );
    expect(await response.text()).toContain("'=unsafe");
  });

  it("rejects a viewer without analytics.view before reading report data", async () => {
    holder.allowed = false;
    const response = await GET(
      new Request(
        "https://acme.storemink.com/api/dashboard/analytics/reports/top-products",
      ),
      { params: Promise.resolve({ report: "top-products" }) },
    );
    expect(response.status).toBe(403);
    expect(holder.topProducts).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown report", async () => {
    const response = await GET(
      new Request(
        "https://acme.storemink.com/api/dashboard/analytics/reports/private",
      ),
      { params: Promise.resolve({ report: "private" }) },
    );
    expect(response.status).toBe(404);
  });
});
