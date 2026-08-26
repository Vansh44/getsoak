/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("server-only", () => ({}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/logistics/connection", () => ({
  getShiprocketSessionForStore: vi.fn(),
}));
vi.mock("@/lib/logistics/shiprocket", () => ({
  checkShiprocketServiceability: vi.fn(),
}));

import { getShiprocketSessionForStore } from "@/lib/logistics/connection";
import { PlanEntitlementError } from "@/lib/plans/entitlements";
import { quoteShippingForOrder } from "./quote";
import type { ShippingSettings } from "./types";

const SETTINGS: ShippingSettings = {
  mode: "shiprocket",
  flatRate: 49,
  freeAbove: 500,
  manualMinDays: 3,
  manualMaxDays: 7,
  handlingDays: 1,
  carrierAdjustmentType: "none",
  carrierAdjustmentValue: 0,
  showAllCouriers: true,
};

describe("quoteShippingForOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "location-1",
            address: { postalCode: "110001" },
            pickupCode: "warehouse",
          },
        ],
      ],
    });
  });

  it("uses a shopper-safe manual fallback when Shiprocket is plan-locked", async () => {
    vi.mocked(getShiprocketSessionForStore).mockRejectedValue(
      new PlanEntitlementError(
        "Shiprocket is available on Basic and Pro. Upgrade your plan.",
      ),
    );

    const result = await quoteShippingForOrder({
      storeId: "store-1",
      fulfilmentLocationId: "location-1",
      deliveryPostcode: "560001",
      cod: true,
      merchandiseSubtotal: 100,
      parcel: {
        weightGrams: 500,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 5,
      },
      settings: SETTINGS,
    });

    expect(result.error).toBeUndefined();
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({
      id: "manual:standard",
      label: "Standard shipping",
      amount: 49,
      courierId: null,
    });
  });
});
