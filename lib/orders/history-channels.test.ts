import { describe, expect, it } from "vitest";
import { isInStoreJourney, shouldShowInStoreHistory } from "./history-channels";

describe("storefront order-history channels", () => {
  it("keeps delivery orders online", () => {
    expect(
      isInStoreJourney({
        sales_channel: "online",
        fulfilment_type: "delivery",
      }),
    ).toBe(false);
  });

  it("groups counter sales and collection orders under In store", () => {
    expect(
      isInStoreJourney({ sales_channel: "pos", fulfilment_type: "delivery" }),
    ).toBe(true);
    expect(
      isInStoreJourney({
        sales_channel: "online",
        fulfilment_type: "pickup",
      }),
    ).toBe(true);
  });

  it("does not advertise an offline channel a store cannot fulfil", () => {
    expect(
      shouldShowInStoreHistory({
        orders: [{ sales_channel: "online", fulfilment_type: "delivery" }],
        supportsPos: false,
        supportsPickup: false,
      }),
    ).toBe(false);
  });

  it("shows the split for a working POS or pickup journey", () => {
    expect(
      shouldShowInStoreHistory({
        orders: [],
        supportsPos: true,
        supportsPickup: false,
      }),
    ).toBe(true);
    expect(
      shouldShowInStoreHistory({
        orders: [],
        supportsPos: false,
        supportsPickup: true,
      }),
    ).toBe(true);
  });

  it("keeps old in-store receipts visible after the feature is disabled", () => {
    expect(
      shouldShowInStoreHistory({
        orders: [{ sales_channel: "pos", fulfilment_type: "delivery" }],
        supportsPos: false,
        supportsPickup: false,
      }),
    ).toBe(true);
  });
});
