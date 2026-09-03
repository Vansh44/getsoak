/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const headerHolder = vi.hoisted(() => ({ ip: "203.0.113.10" }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-forwarded-for" ? headerHolder.ip : null),
  })),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: vi.fn(() => headerHolder.ip),
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
  getManagerIdentity: vi.fn(),
  getViewerContext: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/permissions", () => ({
  can: vi.fn(() => true),
}));
vi.mock("@/lib/fulfilment/resolve", () => ({
  resolveFulfilmentLocation: vi.fn(async () => "location-1"),
}));
vi.mock("@/lib/shipping/rates", () => ({
  manualShippingOption: vi.fn((settings: any, subtotal: number) => ({
    id: "manual:flat",
    label: "Standard delivery",
    description: `${settings.manualMinDays}-${settings.manualMaxDays} days`,
    amount:
      settings.freeAbove !== null && subtotal >= settings.freeAbove
        ? 0
        : settings.flatRate,
    carrierCost: null,
    courierId: null,
    courierName: null,
    estimatedDeliveryMinDays: settings.manualMinDays,
    estimatedDeliveryMaxDays: settings.manualMaxDays,
    estimatedDeliveryAt: null,
    freeShippingApplied:
      settings.freeAbove !== null && subtotal >= settings.freeAbove,
  })),
  packageForShippingLines: vi.fn(() => ({
    weightGrams: 500,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 5,
  })),
}));
vi.mock("@/lib/shipping/quote", () => ({
  quoteShippingForOrder: vi.fn(),
  readShippingSettings: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { rateLimit } from "@/lib/rate-limit";
import { emitEvent } from "@/lib/notifications/record";
import {
  getManagerIdentity,
  getViewerContext,
} from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { resolveFulfilmentLocation } from "@/lib/fulfilment/resolve";
import {
  manualShippingOption,
  packageForShippingLines,
} from "@/lib/shipping/rates";
import {
  quoteShippingForOrder,
  readShippingSettings,
} from "@/lib/shipping/quote";
import {
  products,
  storeLogisticsProviders,
  storeShippingSettings,
} from "@/drizzle/schema";
import {
  getCheckoutShippingOptions,
  getProductDeliveryEstimate,
  getShippingSettings,
  saveShippingSettings,
} from "./shipping-actions";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const VARIANT_ID = "22222222-2222-4222-8222-222222222222";

const SETTINGS = {
  mode: "flat",
  flatRate: 80,
  freeAbove: 500,
  manualMinDays: 3,
  manualMaxDays: 7,
  handlingDays: 1,
  carrierAdjustmentType: "flat",
  carrierAdjustmentValue: 0,
  showAllCouriers: false,
} as any;

const PRODUCT = {
  id: PRODUCT_ID,
  status: "published",
  price: 200,
  basePrice: 250,
  trackInventory: true,
  allowBackorder: false,
  onlineStock: 10,
  requiresShipping: true,
  weightGrams: 250,
  lengthCm: 8,
  widthCm: 7,
  heightCm: 4,
};

const VARIANT = {
  id: VARIANT_ID,
  productId: PRODUCT_ID,
  price: 180,
  basePrice: 220,
  specialPrice: null,
  trackInventory: true,
  allowBackorder: false,
  onlineStock: 6,
  requiresShipping: true,
  weightGrams: 300,
  lengthCm: 9,
  widthCm: 8,
  heightCm: 5,
};

function cartItem(overrides: Record<string, unknown> = {}) {
  return {
    productId: PRODUCT_ID,
    variantId: null,
    quantity: 2,
    name: "Milk",
    price: 999_999,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock();
  headerHolder.ip = "203.0.113.10";
  vi.mocked(getServerUser).mockResolvedValue({
    id: "customer-1",
    email: "shopper@example.com",
  } as any);
  vi.mocked(getViewerContext).mockResolvedValue({
    profile: { id: "admin-1" },
    permissions: {},
    isSuperadmin: true,
  } as any);
  vi.mocked(getManagerIdentity).mockResolvedValue({
    uid: "admin-1",
    email: "owner@acme.test",
  });
  vi.mocked(can).mockReturnValue(true);
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
  vi.mocked(readShippingSettings).mockResolvedValue(SETTINGS);
  vi.mocked(quoteShippingForOrder).mockResolvedValue({
    options: [
      {
        id: "shiprocket:11",
        label: "Courier",
        description: "2-4 days",
        amount: 65,
        carrierCost: 55,
        courierId: "11",
        courierName: "FastEx",
        estimatedDeliveryMinDays: 2,
        estimatedDeliveryMaxDays: 4,
        estimatedDeliveryAt: null,
        freeShippingApplied: false,
      },
    ],
  });
});

describe("getShippingSettings", () => {
  it("returns safe defaults without querying secrets for an unauthorized viewer", async () => {
    vi.mocked(getViewerContext).mockResolvedValue(null);

    const result = await getShippingSettings();

    expect(result.shiprocketConnected).toBe(false);
    expect(result.shiprocketEnabled).toBe(false);
    expect(readShippingSettings).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("enforces settings.view even for a signed-in profile", async () => {
    vi.mocked(can).mockReturnValue(false);
    await getShippingSettings();
    expect(readShippingSettings).not.toHaveBeenCalled();
  });

  it("returns policy plus connection and enabled state", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ enabled: true }]] });

    expect(await getShippingSettings()).toEqual({
      settings: SETTINGS,
      shiprocketConnected: true,
      shiprocketEnabled: true,
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["store-1", "shiprocket"]),
    );
  });
});

describe("saveShippingSettings", () => {
  it("requires settings manage permission", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect(await saveShippingSettings(SETTINGS)).toEqual({
      error: "You don't have permission to change shipping.",
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it.each([
    [{ ...SETTINGS, flatRate: -1 }, /cannot be negative/i],
    [{ ...SETTINGS, freeAbove: 0 }, /greater than zero/i],
    [
      { ...SETTINGS, manualMinDays: 8, manualMaxDays: 2 },
      /valid delivery estimate/i,
    ],
    [
      { ...SETTINGS, manualMinDays: 0, manualMaxDays: 91 },
      /valid delivery estimate/i,
    ],
    [{ ...SETTINGS, handlingDays: 31 }, /handling time/i],
    [{ ...SETTINGS, carrierAdjustmentValue: -1 }, /cannot be negative/i],
  ])("rejects invalid commercial settings %#", async (input, message) => {
    expect((await saveShippingSettings(input as any)).error).toMatch(message);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("normalizes non-finite values instead of persisting NaN", async () => {
    await saveShippingSettings({
      ...SETTINGS,
      flatRate: Number.NaN,
      manualMinDays: Number.NaN,
      manualMaxDays: Number.NaN,
      handlingDays: Number.NaN,
      carrierAdjustmentValue: Number.NaN,
    });

    expect(dbHolder.current.calls.values[0]).toMatchObject({
      flatRate: 0,
      manualMinDays: 3,
      manualMaxDays: 7,
      handlingDays: 1,
      carrierAdjustmentValue: 0,
    });
  });

  it("does not enable live rates without an enabled Shiprocket connection", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ enabled: false }]] });
    expect(
      (await saveShippingSettings({ ...SETTINGS, mode: "shiprocket" })).error,
    ).toMatch(/connect and enable shiprocket/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("upserts trusted settings, revalidates checkout and audits the change", async () => {
    const result = await saveShippingSettings(SETTINGS);

    expect(result).toEqual({ success: true });
    expect(dbHolder.current.calls.insert[0]).toBe(storeShippingSettings);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      updatedBy: "admin-1",
      flatRate: 80,
    });
    expect(dbHolder.current.calls.onConflict).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/settings/shipping");
    expect(revalidatePath).toHaveBeenCalledWith("/checkout");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settings.changed",
        storeId: "store-1",
        actor: { type: "admin", id: "admin-1" },
      }),
    );
  });
});

describe("getCheckoutShippingOptions", () => {
  it("requires a customer session before reading cart data", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect(
      await getCheckoutShippingOptions({
        items: [cartItem()],
        postalCode: "110001",
        paymentMethod: "cod",
      }),
    ).toEqual({ options: [], error: "Sign in to see delivery rates." });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("rate limits quotes per signed-in customer", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    const result = await getCheckoutShippingOptions({
      items: [cartItem()],
      postalCode: "110001",
      paymentMethod: "cod",
    });
    expect(result.error).toMatch(/too many delivery checks/i);
    expect(rateLimit).toHaveBeenCalledWith("shipping-quote:customer-1", {
      max: 40,
      windowSeconds: 60,
    });
  });

  it("rejects empty and oversized carts before any catalog query", async () => {
    expect(
      (
        await getCheckoutShippingOptions({
          items: [],
          postalCode: "110001",
          paymentMethod: "cod",
        })
      ).error,
    ).toMatch(/empty or too large/i);
    expect(
      (
        await getCheckoutShippingOptions({
          items: Array.from({ length: 101 }, () => cartItem()),
          postalCode: "110001",
          paymentMethod: "cod",
        })
      ).error,
    ).toMatch(/empty or too large/i);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("rejects stale products, variants and quantities", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(
      (
        await getCheckoutShippingOptions({
          items: [cartItem()],
          postalCode: "110001",
          paymentMethod: "cod",
        })
      ).error,
    ).toMatch(/cart changed/i);

    dbHolder.current = makeDbMock({ selectQueue: [[PRODUCT]] });
    expect(
      (
        await getCheckoutShippingOptions({
          items: [cartItem({ quantity: 0 })],
          postalCode: "110001",
          paymentMethod: "cod",
        })
      ).error,
    ).toMatch(/cart changed/i);
  });

  it("re-prices from the database and never trusts the cart price", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[PRODUCT]] });

    const result = await getCheckoutShippingOptions({
      items: [cartItem({ quantity: 2, price: 1 })],
      postalCode: "110001",
      paymentMethod: "cod",
    });

    expect(result.options[0].amount).toBe(80);
    // ★ The third argument is whether a `free_shipping` OFFER waives delivery,
    // resolved SERVER-side here — never accepted from the browser, since "an
    // offer waives my delivery charge" is precisely the claim a client would
    // like to make about itself. False when no offer applies.
    expect(manualShippingOption).toHaveBeenCalledWith(SETTINGS, 400, false);
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "store-1",
    );
  });

  it("returns a no-delivery option for an entirely digital cart", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...PRODUCT, requiresShipping: false }]],
    });
    const result = await getCheckoutShippingOptions({
      items: [cartItem()],
      postalCode: "110001",
      paymentMethod: "razorpay",
    });
    expect(result.options).toEqual([
      expect.objectContaining({ id: "digital:none", amount: 0 }),
    ]);
    expect(resolveFulfilmentLocation).not.toHaveBeenCalled();
  });

  it("uses variant price and parcel fields when a variant is selected", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[PRODUCT], [VARIANT]] });
    await getCheckoutShippingOptions({
      items: [cartItem({ variantId: VARIANT_ID, quantity: 3 })],
      postalCode: "110001",
      paymentMethod: "razorpay",
    });
    expect(manualShippingOption).toHaveBeenCalledWith(SETTINGS, 540, false);
    expect(packageForShippingLines).not.toHaveBeenCalled();
  });

  it("quotes live rates from trusted stock, parcel, location and COD state", async () => {
    vi.mocked(readShippingSettings).mockResolvedValue({
      ...SETTINGS,
      mode: "shiprocket",
    });
    dbHolder.current = makeDbMock({ selectQueue: [[PRODUCT]] });

    const result = await getCheckoutShippingOptions({
      items: [cartItem()],
      postalCode: "110001",
      paymentMethod: "cod",
    });

    expect(result.options[0].courierName).toBe("FastEx");
    expect(resolveFulfilmentLocation).toHaveBeenCalledWith(
      "store-1",
      expect.arrayContaining([
        expect.objectContaining({
          productId: PRODUCT_ID,
          quantity: 2,
          needsStock: true,
        }),
      ]),
    );
    expect(quoteShippingForOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        fulfilmentLocationId: "location-1",
        deliveryPostcode: "110001",
        cod: true,
        merchandiseSubtotal: 400,
      }),
    );
  });
});

describe("getProductDeliveryEstimate", () => {
  it("normalizes and validates the delivery PIN before doing work", async () => {
    expect(
      await getProductDeliveryEstimate({
        productId: PRODUCT_ID,
        variantId: null,
        quantity: 1,
        postalCode: "11A-00",
      }),
    ).toMatchObject({
      available: false,
      postalCode: "1100",
      error: "Enter a valid 6-digit delivery PIN code.",
    });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("rejects invalid identifiers and quantities before rate limiting", async () => {
    for (const input of [
      { productId: "not-a-uuid", variantId: null, quantity: 1 },
      { productId: PRODUCT_ID, variantId: "bad", quantity: 1 },
      { productId: PRODUCT_ID, variantId: null, quantity: 0 },
      { productId: PRODUCT_ID, variantId: null, quantity: 100 },
    ]) {
      expect(
        (
          await getProductDeliveryEstimate({
            ...input,
            postalCode: "110001",
          })
        ).error,
      ).toMatch(/product selection is invalid/i);
    }
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("rate limits anonymous PDP checks by client IP", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    const result = await getProductDeliveryEstimate({
      productId: PRODUCT_ID,
      variantId: null,
      quantity: 1,
      postalCode: "110001",
    });
    expect(result.error).toMatch(/too many delivery checks/i);
    expect(rateLimit).toHaveBeenCalledWith("product-delivery:203.0.113.10", {
      max: 30,
      windowSeconds: 60,
    });
  });

  it("returns unavailable when the published product or selected variant vanished", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(
      (
        await getProductDeliveryEstimate({
          productId: PRODUCT_ID,
          variantId: null,
          quantity: 1,
          postalCode: "110001",
        })
      ).error,
    ).toMatch(/no longer available/i);

    dbHolder.current = makeDbMock({ selectQueue: [[PRODUCT], []] });
    expect(
      (
        await getProductDeliveryEstimate({
          productId: PRODUCT_ID,
          variantId: VARIANT_ID,
          quantity: 1,
          postalCode: "110001",
        })
      ).error,
    ).toMatch(/no longer available/i);
  });

  it("does not promise inventory that is unavailable online", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...PRODUCT, onlineStock: 0 }]],
    });
    const none = await getProductDeliveryEstimate({
      productId: PRODUCT_ID,
      variantId: null,
      quantity: 1,
      postalCode: "110001",
    });
    expect(none.error).toMatch(/out of stock/i);

    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...PRODUCT, onlineStock: 2 }]],
    });
    const partial = await getProductDeliveryEstimate({
      productId: PRODUCT_ID,
      variantId: null,
      quantity: 3,
      postalCode: "110001",
    });
    expect(partial.error).toBe("Only 2 available for online delivery.");
    expect(quoteShippingForOrder).not.toHaveBeenCalled();
  });

  it("returns immediate availability for a digital product", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...PRODUCT, requiresShipping: false }]],
    });
    expect(
      await getProductDeliveryEstimate({
        productId: PRODUCT_ID,
        variantId: null,
        quantity: 1,
        postalCode: "110001",
      }),
    ).toMatchObject({
      available: true,
      kind: "digital",
      option: { id: "digital:none", amount: 0 },
    });
  });

  it("uses the variant special price for free-shipping evaluation", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[PRODUCT], [{ ...VARIANT, specialPrice: 300 }]],
    });
    const result = await getProductDeliveryEstimate({
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      quantity: 2,
      postalCode: "110001",
    });
    expect(result.available).toBe(true);
    expect(manualShippingOption).toHaveBeenCalledWith(SETTINGS, 600);
    expect(result.option?.amount).toBe(0);
  });

  it("reports quote failure honestly when no courier serves the PIN", async () => {
    vi.mocked(readShippingSettings).mockResolvedValue({
      ...SETTINGS,
      mode: "shiprocket",
    });
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [],
      error: "No courier services this PIN.",
    });
    dbHolder.current = makeDbMock({ selectQueue: [[PRODUCT]] });
    const result = await getProductDeliveryEstimate({
      productId: PRODUCT_ID,
      variantId: null,
      quantity: 1,
      postalCode: "110001",
    });
    expect(result).toMatchObject({
      available: false,
      kind: "physical",
      error: "No courier services this PIN.",
    });
  });

  it("returns the cheapest option plus an alternative count", async () => {
    vi.mocked(readShippingSettings).mockResolvedValue({
      ...SETTINGS,
      mode: "shiprocket",
    });
    const first = { id: "one", amount: 50 } as any;
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [first, { id: "two", amount: 70 } as any],
    });
    dbHolder.current = makeDbMock({ selectQueue: [[PRODUCT]] });
    const result = await getProductDeliveryEstimate({
      productId: PRODUCT_ID,
      variantId: null,
      quantity: 1,
      postalCode: "110001",
    });
    expect(result.option).toBe(first);
    expect(result.alternativeCount).toBe(1);
    expect(getCurrentStoreId).toHaveBeenCalled();
    expect(dbHolder.current.calls.select[0]).toBeTruthy();
    expect(products).toBeTruthy();
    expect(storeLogisticsProviders).toBeTruthy();
  });
});
