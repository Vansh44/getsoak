/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  brief: vi.fn(),
  catalog: vi.fn(),
  rows: [] as any[],
  service: vi.fn(),
}));
vi.mock("./business-brief-data", () => ({
  collectBusinessBriefSnapshot: h.brief,
}));
vi.mock("./catalog-health-read", () => ({ readMinkCatalogHealth: h.catalog }));
vi.mock("@/lib/db/client", () => ({ withService: h.service }));
import { collectProactiveResponse } from "./proactive-response-data";
const input = {
  responseId: "approval",
  signal: "inventory",
  period: "daily",
  timeZone: "Asia/Kolkata",
  requestedAt: "2026-09-06T12:00:00Z",
  locationIds: ["Shop", "Delhi"],
  locationLabel: "Shop and Delhi",
  requesterEmail: null,
  includeUnassigned: false,
  defaultLowStockThreshold: 5,
} as any;
const scope = {
  locationIds: ["Shop", "Delhi"],
  locationLabel: "Shop and Delhi",
};
const snapshot = {
  period: "daily",
  rangeLabel: "Yesterday",
  comparisonLabel: "Previous",
  fromInclusive: "2026-09-05T00:00:00Z",
  toExclusive: "2026-09-06T00:00:00Z",
  timeZone: "Asia/Kolkata",
  currency: "INR",
  locationLabel: "Shop and Delhi",
  netSales: 50,
  previousNetSales: 100,
  orders: 5,
  previousOrders: 10,
  returns: 10,
  previousReturns: 5,
  createdOrders: 10,
  failedPaymentOrders: 3,
  locations: [
    { id: "Shop", name: "Shop", trackedItems: 20, lowStock: 2, outOfStock: 1 },
    {
      id: "Delhi",
      name: "Delhi",
      trackedItems: 20,
      lowStock: 1,
      outOfStock: 3,
    },
  ],
  dataAsOf: "2026-09-06T12:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  h.brief.mockResolvedValue(snapshot);
  h.catalog.mockResolvedValue({
    items: [
      {
        productName: "Rice",
        sku: "RICE5",
        stock: 0,
        threshold: 5,
        inventoryStatus: "out",
      },
    ],
    truncated: false,
  });
  h.service.mockResolvedValue([{ id: "safe-order-id", status: "failed" }]);
});
describe("fresh approved investigation evidence", () => {
  it("keeps Delhi and Shop separate and prioritizes the worse stock location", async () => {
    const r = await collectProactiveResponse("echos", "owner", input, scope);
    expect(h.catalog.mock.calls[0][0]).toMatchObject({
      storeId: "echos",
      locationIds: ["Delhi"],
      limit: 21,
    });
    expect(r.rows[0].detail).toContain("Delhi");
    expect(r.rows[1].detail).toContain("Shop");
    expect(r.nextSteps.join(" ")).toContain("counted quantity");
  });
  it("caps details at 20 and locations at 3 without hiding truncation", async () => {
    h.brief.mockResolvedValue({
      ...snapshot,
      locations: Array.from({ length: 5 }, (_, i) => ({
        ...snapshot.locations[0],
        id: String(i),
      })),
    });
    h.catalog.mockResolvedValue({
      items: Array.from({ length: 21 }, () => ({
        productName: "Rice",
        sku: "RICE",
        stock: 0,
        threshold: 5,
        inventoryStatus: "out",
      })),
      truncated: true,
    });
    const r = await collectProactiveResponse("echos", "owner", input, scope);
    expect(r.rows).toHaveLength(20);
    expect(h.catalog).toHaveBeenCalledTimes(3);
    expect(r.truncated).toBe(true);
  });
  it("suppresses remedies if the signal recovered", async () => {
    h.brief.mockResolvedValue({
      ...snapshot,
      locations: snapshot.locations.map((l) => ({
        ...l,
        lowStock: 0,
        outOfStock: 0,
      })),
    });
    const r = await collectProactiveResponse("echos", "owner", input, scope);
    expect(r.rows).toEqual([]);
    expect(h.catalog).not.toHaveBeenCalled();
    expect(r.nextSteps[0]).toContain("No remedy was applied");
  });
  it("does not equate insufficient data with recovery", async () => {
    h.brief.mockResolvedValue({ ...snapshot, locations: [] });
    const r = await collectProactiveResponse("echos", "owner", input, scope);
    expect(r.evidence.status).toBe("insufficient_data");
    expect(r.nextSteps[0]).toContain("not enough");
  });
  it("propagates source errors, never fabricates zero stock", async () => {
    h.catalog.mockRejectedValue(new Error("database unavailable"));
    await expect(
      collectProactiveResponse("echos", "owner", input, scope),
    ).rejects.toThrow("database unavailable");
  });
  it.each(["returns", "payments"])(
    "bounds %s records and does not expose customer contact fields",
    async (signal) => {
      h.service.mockResolvedValue(
        Array.from({ length: 21 }, () => ({
          id: "record",
          status: "pending",
          email: "private@example.com",
        })),
      );
      const r = await collectProactiveResponse(
        "echos",
        "owner",
        { ...input, signal },
        scope,
      );
      expect(r.rows).toHaveLength(20);
      expect(r.truncated).toBe(true);
      expect(JSON.stringify(r)).not.toContain("private@example.com");
    },
  );
  it("sales recommendations report comparisons, not invented causes or forecasts", async () => {
    const r = await collectProactiveResponse(
      "echos",
      "owner",
      { ...input, signal: "sales" },
      scope,
    );
    expect(r.rows).toHaveLength(2);
    expect(r.nextSteps.join(" ")).toContain("does not establish a cause");
    expect(h.service).not.toHaveBeenCalled();
  });
});
