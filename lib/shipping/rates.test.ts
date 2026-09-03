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

describe("free shipping — cheapest wins between the policy and an offer", () => {
  it("★ an offer LOWERS the threshold and never raises the charge", () => {
    // A store whose standing policy is free-above-₹999 and whose offer is
    // free-above-₹500 has temporarily lowered its threshold. Any rule other
    // than cheapest-wins produces a cart where ADDING items increases delivery
    // cost, which no shopper reads as anything but a bug.
    const config = settings({ mode: "flat", flatRate: 60, freeAbove: 999 });

    // ₹600: below the standing threshold, but the offer applies.
    expect(freeShippingApplies(config, 600, true)).toBe(true);
    expect(freeShippingApplies(config, 600, false)).toBe(false);

    // ₹1,200: already free under the standing policy, with or without it.
    expect(freeShippingApplies(config, 1200, true)).toBe(true);
    expect(freeShippingApplies(config, 1200, false)).toBe(true);
  });

  it("defaults to no offer, so every existing caller is unchanged", () => {
    const config = settings({ mode: "flat", flatRate: 60, freeAbove: 999 });
    expect(freeShippingApplies(config, 600)).toBe(false);
  });

  it("credits the OFFER only with what it actually waived", () => {
    // ★ The budget question. An offer that waived nothing — because the cart
    // already shipped free — must be charged nothing, or a merchant who capped
    // a free-delivery campaign at ₹5,000 would watch it burn on orders that
    // were always going to ship free.
    const config = settings({ mode: "flat", flatRate: 60, freeAbove: 999 });

    const belowThreshold = manualShippingOption(config, 600, true);
    expect(belowThreshold.amount).toBe(0);
    expect(belowThreshold.offerWaivedAmount).toBe(60);

    const alreadyFree = manualShippingOption(config, 1200, true);
    expect(alreadyFree.amount).toBe(0);
    expect(alreadyFree.offerWaivedAmount).toBe(0);

    const noOffer = manualShippingOption(config, 600, false);
    expect(noOffer.amount).toBe(60);
    expect(noOffer.offerWaivedAmount).toBe(0);
  });

  it("credits nothing on an always-free store", () => {
    const config = settings({ mode: "free" });
    expect(manualShippingOption(config, 100, true).offerWaivedAmount).toBe(0);
  });

  it("waives the MARKED-UP carrier rate, which is what the shopper would have paid", () => {
    const config = settings({
      mode: "shiprocket",
      freeAbove: null,
      carrierAdjustmentType: "percentage",
      carrierAdjustmentValue: 10,
    });
    const raw = {
      data: {
        available_courier_companies: [
          {
            courier_company_id: 7,
            courier_name: "Bluedart",
            rate: 100,
            etd: "2 days",
          },
        ],
      },
    };
    const [option] = shiprocketShippingOptions(raw, config, 600, true);
    expect(option.amount).toBe(0);
    // 100 + 10% markup — the merchant's margin was part of that price too.
    expect(option.offerWaivedAmount).toBe(110);
    expect(option.carrierCost).toBe(100);
  });
});
