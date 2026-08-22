import { describe, expect, it } from "vitest";
import {
  isValidGa4MeasurementId,
  isValidMetaPixelId,
  resolveMerchantPixelSettings,
} from "./merchant-pixels";

describe("merchant pixel settings", () => {
  it("normalizes valid IDs and keeps explicit enable switches", () => {
    expect(
      resolveMerchantPixelSettings({
        marketing: {
          ga4MeasurementId: " g-ab12cd34 ",
          ga4Enabled: true,
          metaPixelId: " 123456789012345 ",
          metaPixelEnabled: true,
        },
      }),
    ).toEqual({
      ga4MeasurementId: "G-AB12CD34",
      ga4Enabled: true,
      metaPixelId: "123456789012345",
      metaPixelEnabled: true,
    });
  });

  it("fails closed for malformed stored IDs", () => {
    expect(
      resolveMerchantPixelSettings({
        marketing: {
          ga4MeasurementId: "<script>",
          ga4Enabled: true,
          metaPixelId: "12px",
          metaPixelEnabled: true,
        },
      }),
    ).toEqual({
      ga4MeasurementId: "",
      ga4Enabled: false,
      metaPixelId: "",
      metaPixelEnabled: false,
    });
  });

  it("accepts only provider-shaped IDs", () => {
    expect(isValidGa4MeasurementId("G-ABC12345")).toBe(true);
    expect(isValidGa4MeasurementId("UA-12345")).toBe(false);
    expect(isValidMetaPixelId("1234567890")).toBe(true);
    expect(isValidMetaPixelId("pixel-123")).toBe(false);
  });
});
