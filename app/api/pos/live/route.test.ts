import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/pos/permissions", () => ({ posCan: vi.fn(() => true) }));
vi.mock("@/lib/pos/pickup-count", () => ({ readPickupsWaiting: vi.fn() }));
vi.mock("@/app/actions/pos-pickup-actions", () => ({
  getPickupQueue: vi.fn(),
}));
vi.mock("@/app/actions/pos-inventory-actions", () => ({
  getPosInventory: vi.fn(),
}));
vi.mock("@/app/actions/pos-sale-actions", () => ({
  getCatalogSnapshot: vi.fn(),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { readPickupsWaiting } from "@/lib/pos/pickup-count";
import { getPickupQueue } from "@/app/actions/pos-pickup-actions";
import { getPosInventory } from "@/app/actions/pos-inventory-actions";
import { getCatalogSnapshot } from "@/app/actions/pos-sale-actions";
import { GET } from "./route";

const OPERATOR = {
  role: "cashier" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "staff-1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

const request = (need: string, extra = "") =>
  new NextRequest(`http://localhost/api/pos/live?need=${need}${extra}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(OPERATOR);
  vi.mocked(posCan).mockReturnValue(true);
  vi.mocked(readPickupsWaiting).mockResolvedValue(3);
  vi.mocked(getPickupQueue).mockResolvedValue({ orders: [] });
  vi.mocked(getPosInventory).mockResolvedValue({ items: [] });
  vi.mocked(getCatalogSnapshot).mockResolvedValue({
    items: [],
    nextCursor: null,
  });
});

describe("GET /api/pos/live", () => {
  it("keeps a failed count distinct from a real zero", async () => {
    vi.mocked(readPickupsWaiting).mockRejectedValue(new Error("db down"));
    const response = await GET(request("pickups"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("returns 401 for a signed-out count poll", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    const response = await GET(request("pickups"));
    expect(response.status).toBe(401);
  });

  it("does not turn a denied count poll into a real zero", async () => {
    vi.mocked(posCan).mockReturnValue(false);
    const response = await GET(request("pickups"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not-allowed" });
    expect(readPickupsWaiting).not.toHaveBeenCalled();
  });

  it.each([
    ["queue", getPickupQueue],
    ["stock", getPosInventory],
    ["catalog", getCatalogSnapshot],
  ] as const)(
    "lets the %s action own the only operator resolution",
    async (need, action) => {
      const response = await GET(request(need));
      expect(response.status).toBe(200);
      expect(action).toHaveBeenCalledTimes(1);
      expect(resolvePosOperator).not.toHaveBeenCalled();
    },
  );

  it("forwards the catalogue cursor", async () => {
    await GET(request("catalog", "&cursor=product-300"));
    expect(getCatalogSnapshot).toHaveBeenCalledWith("product-300", null);
  });

  it("forwards the delta watermark", async () => {
    await GET(request("catalog", "&since=2026-08-21T10:00:00.000Z"));
    expect(getCatalogSnapshot).toHaveBeenCalledWith(
      null,
      "2026-08-21T10:00:00.000Z",
    );
  });

  // ★ A MISSING `since` MUST REACH THE ACTION AS A FALSY VALUE, never as the
  // string "null". The action parses it with Date.parse, and "null" is NaN —
  // which it degrades to a full sync anyway, so this would not break. What it
  // WOULD break is the honest reading of the request: a till that never sent a
  // watermark would be indistinguishable from one that sent a broken one.
  it("asks for a full pull when the till has no watermark yet", async () => {
    await GET(request("catalog"));
    expect(getCatalogSnapshot).toHaveBeenCalledWith(null, null);
  });
});
