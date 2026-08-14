import { describe, expect, it, vi } from "vitest";
import {
  freeShippingApplies,
  manualShippingOption,
  packageForShippingLines,
  shiprocketShippingOptions,
} from "./rates";
import { DEFAULT_SHIPPING_SETTINGS, type ShippingSettings } from "./types";

function settings(patch: Partial<ShippingSettings> = {}): ShippingSettings {
  return { ...DEFAULT_SHIPPING_SETTINGS, ...patch };
}

describe("checkout shipping rates", () => {
  it("charges one fixed amount regardless of destination", () => {
    const option = manualShippingOption(
      settings({ mode: "flat", flatRate: 50 }),
      200,
    );
    expect(option.amount).toBe(50);
    expect(option.label).toBe("Standard shipping");
  });

  it("makes a fixed rate free at the configured subtotal", () => {
    const config = settings({ mode: "flat", flatRate: 50, freeAbove: 500 });
    expect(freeShippingApplies(config, 499)).toBe(false);
    expect(freeShippingApplies(config, 500)).toBe(true);
    expect(manualShippingOption(config, 500).amount).toBe(0);
  });

  it("normalizes, marks up and sorts Shiprocket couriers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    const options = shiprocketShippingOptions(
      {
        data: {
          available_courier_companies: [
            {
              courier_company_id: 2,
              courier_name: "Fast Air",
              rate: 120,
              estimated_delivery_days: 2,
            },
            {
              courier_company_id: 1,
              courier_name: "Ground",
              freight_charge: "80",
              estimated_delivery_days: "4",
            },
          ],
        },
      },
      settings({
        mode: "shiprocket",
        handlingDays: 1,
        carrierAdjustmentType: "percentage",
        carrierAdjustmentValue: 10,
      }),
      300,
    );

    expect(options.map((option) => option.id)).toEqual([
      "shiprocket:1",
      "shiprocket:2",
    ]);
    expect(options[0]).toMatchObject({
      amount: 88,
      carrierCost: 80,
      estimatedDeliveryMaxDays: 5,
    });
    vi.useRealTimers();
  });

  it("keeps courier choice but charges zero above the free threshold", () => {
    const [option] = shiprocketShippingOptions(
      {
        data: {
          available_courier_companies: [
            {
              courier_company_id: 10,
              courier_name: "Courier",
              rate: 90,
              estimated_delivery_days: 3,
            },
          ],
        },
      },
      settings({ mode: "shiprocket", freeAbove: 500 }),
      700,
    );
    expect(option).toMatchObject({
      amount: 0,
      carrierCost: 90,
      freeShippingApplied: true,
      courierId: "10",
    });
  });

  it("computes safe parcel defaults for serviceability", () => {
    expect(
      packageForShippingLines([
        {
          quantity: 2,
          requiresShipping: true,
          weightGrams: 300,
          lengthCm: 8,
          widthCm: null,
          heightCm: 4,
        },
      ]),
    ).toEqual({
      weightGrams: 600,
      lengthCm: 10,
      widthCm: 10,
      heightCm: 8,
    });
  });
});
