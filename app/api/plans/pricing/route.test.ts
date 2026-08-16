import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/plans/pricing", () => ({ getPlanPricingLive: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { getPlanPricingLive } from "@/lib/plans/pricing";
import { GET } from "./route";

const PRICING = {
  free: {
    monthlyInr: 0,
    yearlyInr: 0,
    baseMonthlyInr: null,
    baseYearlyInr: null,
  },
  basic: {
    monthlyInr: 1500,
    yearlyInr: 15000,
    baseMonthlyInr: 2000,
    baseYearlyInr: 20000,
  },
  pro: {
    monthlyInr: 2400,
    yearlyInr: 24000,
    baseMonthlyInr: 5000,
    baseYearlyInr: 50000,
  },
};

describe("GET /api/plans/pricing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the uncached operator-managed quote", async () => {
    vi.mocked(getPlanPricingLive).mockResolvedValue(PRICING);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(PRICING);
  });

  it("fails closed instead of quoting compiled defaults when the DB is down", async () => {
    vi.mocked(getPlanPricingLive).mockRejectedValue(new Error("offline"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Current plan pricing is temporarily unavailable.",
    });
  });
});
